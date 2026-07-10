import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { jsonToHtml, jsonToNode } from '../../collaboration/collaboration.util';
import { ExportFormat } from './dto/export-dto';
import { Page } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as JSZip from 'jszip';
import { StorageService } from '../storage/storage.service';
import * as puppeteer from 'puppeteer-core';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildTree,
  computeLocalPath,
  getExportExtension,
  getPageTitle,
  getSafePageTitle,
  PageExportTree,
  replaceInternalLinks,
  updateAttachmentUrlsToLocalPaths,
} from './utils';
import {
  ExportMetadata,
  ExportPageMetadata,
} from '../../common/helpers/types/export-metadata.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import slugify from '@sindresorhus/slugify';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('../../../package.json');
import { EnvironmentService } from '../environment/environment.service';
import { DomainService } from '../environment/domain.service';
import {
  getAttachmentIds,
  getProsemirrorContent,
} from '../../common/helpers/prosemirror/utils';
import { htmlToMarkdown } from '@docmost/editor-ext';

type AllowedAttachment = { id: string; fileName: string; filePath: string };

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
    private readonly environmentService: EnvironmentService,
    private readonly domainService: DomainService,
  ) {}

  async exportPage(format: string, page: Page, singlePage?: boolean) {
    const titleNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: getPageTitle(page.title) }],
    };

    let prosemirrorJson: any;

    if (singlePage) {
      const baseUrl = await this.getWorkspaceBaseUrl(page.workspaceId);
      prosemirrorJson = await this.turnPageMentionsToLinks(
        getProsemirrorContent(page.content),
        page.workspaceId,
        baseUrl,
      );
    } else {
      // mentions is already turned to links during the zip process
      prosemirrorJson = getProsemirrorContent(page.content);
    }

    if (page.title) {
      prosemirrorJson.content.unshift(titleNode);
    }
    
    if (format === ExportFormat.PDF) {
      prosemirrorJson = await this.embedImagesAsBase64(prosemirrorJson);
    }

    const pageHtml = jsonToHtml(prosemirrorJson);

    if (format === ExportFormat.HTML) {
      return `<!DOCTYPE html>
      <html>
        <head>
         <title>${getPageTitle(page.title)}</title>
        </head>
        <body>${pageHtml}</body>
      </html>`;
    }

    if (format === ExportFormat.Markdown) {
      const newPageHtml = pageHtml.replace(
        /<colgroup[^>]*>[\s\S]*?<\/colgroup>/gim,
        '',
      );
      return htmlToMarkdown(newPageHtml);
    }
    
    if (format === ExportFormat.PDF) {
      const html = `<!DOCTYPE html>
      <html>
        <head>
         <title>${getPageTitle(page.title)}</title>
         <style>
           body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; color: #37352f; line-height: 1.5; }
           img { max-width: 100%; height: auto; border-radius: 4px; }
           table { border-collapse: collapse; width: 100%; margin: 16px 0; }
           th, td { border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; }
           th { background-color: #f6f8fa; }
           blockquote { border-left: 4px solid #dfe2e5; margin: 0; padding-left: 16px; color: #6a737d; }
           code { background-color: rgba(27,31,35,0.05); padding: 0.2em 0.4em; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace; font-size: 85%; }
           pre { background-color: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; line-height: 1.45; }
           pre code { background-color: transparent; padding: 0; font-size: 100%; }
           h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
           h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
           h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
           ul[data-type="taskList"] { list-style: none; padding-left: 0; }
           li[data-type="taskItem"] { display: flex; margin-bottom: 4px; }
           li[data-type="taskItem"] > label { margin-right: 8px; }
           div[data-type="callout"] { padding: 16px; background-color: #f8f9fa; border-left: 4px solid #0366d6; border-radius: 4px; margin: 16px 0; }
         </style>
        </head>
        <body>${pageHtml}</body>
      </html>`;
      return this.convertHtmlToPdfBuffer(html);
    }
    return;
  }

  private async convertHtmlToPdfBuffer(htmlContent: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
      });
      return await this.compressPdfBuffer(Buffer.from(pdfBuffer));
    } finally {
      await browser.close();
    }
  }

  private async compressPdfBuffer(inputBuffer: Buffer): Promise<Buffer> {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `input-${Date.now()}-${Math.random()}.pdf`);
    const outputPath = path.join(tmpDir, `output-${Date.now()}-${Math.random()}.pdf`);

    await fs.promises.writeFile(inputPath, inputBuffer);

    return new Promise((resolve, reject) => {
      const gsCommand = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${outputPath} ${inputPath}`;
      
      exec(gsCommand, async (error) => {
        try {
          if (error) {
            this.logger.warn(`Ghostscript compression failed, falling back to original: ${error.message}`);
            resolve(inputBuffer);
          } else {
            const compressedBuffer = await fs.promises.readFile(outputPath);
            resolve(compressedBuffer);
          }
        } catch (readError) {
          this.logger.warn(`Failed to read compressed file, falling back to original`);
          resolve(inputBuffer);
        } finally {
          fs.promises.unlink(inputPath).catch(() => {});
          fs.promises.unlink(outputPath).catch(() => {});
        }
      });
    });
  }

  private async embedImagesAsBase64(prosemirrorJson: any): Promise<any> {
    const doc = jsonToNode(prosemirrorJson);
    if (!doc) return prosemirrorJson;

    const attachmentIds = getAttachmentIds(prosemirrorJson);
    if (attachmentIds.length === 0) return prosemirrorJson;

    const attachments = await this.db.selectFrom('attachments')
        .select(['id', 'filePath', 'mimeType'])
        .where('id', 'in', attachmentIds)
        .execute();
    
    const attachmentMap = new Map(attachments.map(a => [a.id, a]));
    const promises: Promise<void>[] = [];

    doc.descendants((node: Node) => {
      // @ts-ignore
      if (node.type.name === 'tiptapImage' || (node.type.name === 'attachment' && node.attrs.mimeType?.startsWith('image/'))) {
        // @ts-ignore
        const attachmentId = node.attrs.attachmentId;
        const attachment = attachmentMap.get(attachmentId);
        if (attachment) {
          promises.push((async () => {
             try {
               const buffer = await this.storageService.read(attachment.filePath);
               const base64 = buffer.toString('base64');
               const mimeType = attachment.mimeType || 'image/png';
               // @ts-ignore
               node.attrs.src = `data:${mimeType};base64,${base64}`;
             } catch (e) {
               this.logger.error(`Failed to read attachment ${attachment.id}`, e);
             }
          })());
        }
      }
    });

    await Promise.all(promises);
    return doc.toJSON();
  }

  async exportPages(
    pageId: string,
    format: string,
    includeAttachments: boolean,
    includeChildren: boolean,
    userId?: string,
    ignorePermissions = false,
  ) {
    let pages: Page[];

    if (includeChildren) {
      //@ts-ignore
      pages = await this.pageRepo.getPageAndDescendants(pageId, {
        includeContent: true,
      });
    } else {
      // Only fetch the single page when includeChildren is false
      const page = await this.pageRepo.findById(pageId, {
        includeContent: true,
      });
      if (page) {
        pages = [page];
      }
    }

    if (!pages || pages.length === 0) {
      throw new BadRequestException('No pages to export');
    }

    if (!ignorePermissions && userId) {
      pages = await this.filterPagesForExport(
        pages,
        pageId,
        userId,
        pages[0].spaceId,
      );
      if (pages.length === 0) {
        throw new BadRequestException('No accessible pages to export');
      }
    }

    const parentPageIndex = pages.findIndex((obj) => obj.id === pageId);

    //After filtering by permissions, if the root page itself is not accessible to the user, findIndex returns -1
    if (parentPageIndex === -1) {
      throw new BadRequestException('Root page is not accessible');
    }
    // set to null to make export of pages with parentId work
    pages[parentPageIndex].parentPageId = null;

    const isSinglePage = pages.length === 1 && !includeAttachments;

    if (isSinglePage) {
      const pageContent = await this.exportPage(format, pages[0], true);
      return { type: 'file' as const, content: pageContent, page: pages[0] };
    }

    const tree = buildTree(pages as Page[]);

    const baseUrl = await this.getWorkspaceBaseUrl(pages[0].workspaceId);
    const zip = new JSZip();
    await this.zipPages(
      tree,
      format,
      zip,
      includeAttachments,
      baseUrl,
      userId,
      ignorePermissions,
    );

    const zipFile = zip.generateNodeStream({
      type: 'nodebuffer',
      streamFiles: true,
      compression: 'DEFLATE',
    });

    return { type: 'zip' as const, stream: zipFile, page: pages[0] };
  }

  async exportSpace(
    spaceId: string,
    format: string,
    includeAttachments: boolean,
    userId?: string,
    ignorePermissions = false,
  ) {
    const space = await this.db
      .selectFrom('spaces')
      .select(['id', 'name'])
      .where('id', '=', spaceId)
      .executeTakeFirst();

    if (!space) {
      throw new NotFoundException('Space not found');
    }

    let pages = await this.db
      .selectFrom('pages')
      .select([
        'pages.id',
        'pages.slugId',
        'pages.title',
        'pages.icon',
        'pages.position',
        'pages.content',
        'pages.parentPageId',
        'pages.spaceId',
        'pages.workspaceId',
        'pages.createdAt',
        'pages.updatedAt',
      ])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .execute();

    if (!ignorePermissions && userId) {
      pages = await this.filterPagesForExport(
        pages as Page[],
        null,
        userId,
        spaceId,
      );
      if (pages.length === 0) {
        throw new BadRequestException('No accessible pages to export');
      }
    }

    const tree = buildTree(pages as Page[]);

    const baseUrl = await this.getWorkspaceBaseUrl(pages[0].workspaceId);
    const zip = new JSZip();

    await this.zipPages(
      tree,
      format,
      zip,
      includeAttachments,
      baseUrl,
      userId,
      ignorePermissions,
    );

    const zipFile = zip.generateNodeStream({
      type: 'nodebuffer',
      streamFiles: true,
      compression: 'DEFLATE',
    });

    const fileName = `${space.name}-space-export.zip`;
    return {
      fileStream: zipFile,
      fileName,
      spaceName: space.name,
    };
  }

  async zipPages(
    tree: PageExportTree,
    format: string,
    zip: JSZip,
    includeAttachments: boolean,
    baseUrl: string,
    userId?: string,
    ignorePermissions = false,
  ): Promise<void> {
    const slugIdToPath: Record<string, string> = {};
    const pageIdToFilePath: Record<string, string> = {};
    const pagesMetadata: Record<string, ExportPageMetadata> = {};

    computeLocalPath(tree, format, null, '', slugIdToPath);

    // Batch resolve attachments once for the whole export so we only run the
    // owning-page view check a single time, regardless of page count.
    const allowedAttachments = includeAttachments
      ? await this.resolveAccessibleAttachments(tree, userId, ignorePermissions)
      : new Map<string, AllowedAttachment>();

    const stack: { folder: JSZip; parentPageId: string | null }[] = [
      { folder: zip, parentPageId: null },
    ];

    while (stack.length > 0) {
      const { folder, parentPageId } = stack.pop();
      const children = tree[parentPageId] || [];

      for (const page of children) {
        const childPages = tree[page.id] || [];

        const prosemirrorJson = await this.turnPageMentionsToLinks(
          getProsemirrorContent(page.content),
          page.workspaceId,
          baseUrl,
          userId,
          ignorePermissions,
        );

        const currentPagePath = slugIdToPath[page.slugId];

        let updatedJsonContent = replaceInternalLinks(
          prosemirrorJson,
          slugIdToPath,
          currentPagePath,
          baseUrl,
        );

        if (includeAttachments) {
          await this.zipAttachments(updatedJsonContent, folder, allowedAttachments);
          updatedJsonContent =
            updateAttachmentUrlsToLocalPaths(updatedJsonContent);
        }

        const pageTitle = getSafePageTitle(page.title);
        const pageExportContent = await this.exportPage(format, {
          ...page,
          content: updatedJsonContent,
        });

        folder.file(
          `${pageTitle}${getExportExtension(format)}`,
          pageExportContent,
        );

        pageIdToFilePath[page.id] = currentPagePath;

        const parentPath = parentPageId ? pageIdToFilePath[parentPageId] : null;
        pagesMetadata[currentPagePath] = {
          pageId: page.id,
          slugId: page.slugId,
          icon: page.icon ?? null,
          position: page.position,
          parentPath,
          createdAt: page.createdAt?.toISOString() ?? new Date().toISOString(),
          updatedAt: page.updatedAt?.toISOString() ?? new Date().toISOString(),
        };

        if (childPages.length > 0) {
          const pageFolder = folder.folder(pageTitle);
          stack.push({ folder: pageFolder, parentPageId: page.id });
        }
      }
    }

    const metadata: ExportMetadata = {
      exportedAt: new Date().toISOString(),
      source: 'docmost',
      version: packageJson.version,
      pages: pagesMetadata,
    };

    zip.file('docmost-metadata.json', JSON.stringify(metadata, null, 2));
  }

  async zipAttachments(
    prosemirrorJson: any,
    zip: JSZip,
    allowed: Map<string, AllowedAttachment>,
  ) {
    const attachmentIds = getAttachmentIds(prosemirrorJson);

    await Promise.all(
      attachmentIds.map(async (id) => {
        const attachment = allowed.get(id);
        if (!attachment) return;
        try {
          const fileBuffer = await this.storageService.read(
            attachment.filePath,
          );
          const filePath = `/files/${attachment.id}/${attachment.fileName}`;
          zip.file(filePath, fileBuffer);
        } catch (err) {
          this.logger.debug(`Attachment export error ${attachment.id}`, err);
        }
      }),
    );
  }

  private async resolveAccessibleAttachments(
    tree: PageExportTree,
    userId: string | undefined,
    ignorePermissions: boolean,
  ): Promise<Map<string, AllowedAttachment>> {
    const allAttachmentIds = new Set<string>();
    let spaceId: string | undefined;
    for (const siblings of Object.values(tree)) {
      for (const page of siblings) {
        if (!spaceId) spaceId = page.spaceId;
        for (const id of getAttachmentIds(getProsemirrorContent(page.content))) {
          allAttachmentIds.add(id);
        }
      }
    }

    if (allAttachmentIds.size === 0 || !spaceId) {
      return new Map();
    }

    const attachments = await this.db
      .selectFrom('attachments')
      .select(['id', 'fileName', 'filePath', 'pageId'])
      .where('id', 'in', [...allAttachmentIds])
      .where('spaceId', '=', spaceId)
      .execute();

    let visible = attachments;
    if (!ignorePermissions && userId) {
      const ownerPageIds = [
        ...new Set(
          attachments
            .map((a) => a.pageId)
            .filter((id): id is string => !!id),
        ),
      ];
      const accessible = ownerPageIds.length
        ? await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: ownerPageIds,
            userId,
            spaceId,
          })
        : [];
      const accessibleSet = new Set(accessible);
      visible = attachments.filter(
        (a) => a.pageId && accessibleSet.has(a.pageId),
      );
    }

    return new Map(visible.map((a) => [a.id, a]));
  }

  async turnPageMentionsToLinks(
    prosemirrorJson: any,
    workspaceId: string,
    baseUrl: string,
    userId?: string,
    ignorePermissions = false,
  ) {
    const doc = jsonToNode(prosemirrorJson);

    let pageMentionIds: string[] = [];

    doc.descendants((node: Node) => {
      if (node.type.name === 'mention' && node.attrs.entityType === 'page') {
        if (node.attrs.entityId) {
          pageMentionIds.push(node.attrs.entityId);
        }
      }
    });

    if (pageMentionIds.length < 1) {
      return prosemirrorJson;
    }

    // Filter to only accessible pages if permissions are enforced
    if (!ignorePermissions && userId) {
      pageMentionIds = await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: pageMentionIds,
        userId,
      });
    }

    const pages =
      pageMentionIds.length > 0
        ? await this.db
            .selectFrom('pages')
            .select([
              'id',
              'slugId',
              'title',
              'creatorId',
              'spaceId',
              'workspaceId',
            ])
            .select((eb) => this.pageRepo.withSpace(eb))
            .where('id', 'in', pageMentionIds)
            .where('workspaceId', '=', workspaceId)
            .execute()
        : [];

    const pageMap = new Map(pages.map((page) => [page.id, page]));

    let editorState = EditorState.create({
      doc: doc,
    });

    const transaction = editorState.tr;

    let offset = 0;

    /**
     * Helper function to replace a mention node with a link node.
     */
    const replaceMentionWithLink = (
      node: Node,
      pos: number,
      title: string,
      slugId: string,
      spaceSlug: string,
    ) => {
      const linkTitle = title || 'untitled';
      const truncatedTitle = linkTitle?.substring(0, 70);
      const pageSlug = `${slugify(truncatedTitle)}-${slugId}`;

      const link = `${baseUrl}/s/${spaceSlug}/p/${pageSlug}`;

      // Create a link mark and a text node with that mark
      const linkMark = editorState.schema.marks.link.create({ href: link });
      const linkTextNode = editorState.schema.text(linkTitle, [linkMark]);

      // Calculate positions (adjusted by the current offset)
      const from = pos + offset;
      const to = pos + offset + node.nodeSize;

      // Replace the node in the transaction and update the offset
      transaction.replaceWith(from, to, linkTextNode);
      offset += linkTextNode.nodeSize - node.nodeSize;
    };

    // find and convert page mentions to links
    editorState.doc.descendants((node: Node, pos: number) => {
      // Check if the node is a page mention
      if (node.type.name === 'mention' && node.attrs.entityType === 'page') {
        const { entityId: pageId, slugId, label } = node.attrs;
        const page = pageMap.get(pageId);

        if (page) {
          replaceMentionWithLink(
            node,
            pos,
            page.title,
            page.slugId,
            page.space.slug,
          );
        } else {
          // if page is not found, default to  the node label and slugId
          replaceMentionWithLink(node, pos, label, slugId, 'undefined');
        }
      }
    });

    if (transaction.docChanged) {
      editorState = editorState.apply(transaction);
    }

    const updatedDoc = editorState.doc;

    return updatedDoc.toJSON();
  }

  private async getWorkspaceBaseUrl(workspaceId: string): Promise<string> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('hostname')
      .where('id', '=', workspaceId)
      .executeTakeFirst();

    return this.domainService.getUrl(workspace?.hostname);
  }

  private async filterPagesForExport(
    pages: Page[],
    rootPageId: string | null,
    userId: string,
    spaceId: string,
  ): Promise<Page[]> {
    if (pages.length === 0) return [];

    const pageIds = pages.map((p) => p.id);
    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds,
        userId,
        spaceId,
      },
    );
    const accessibleSet = new Set(accessibleIds);

    const includedIds = new Set<string>();

    let changed = true;
    while (changed) {
      changed = false;
      for (const page of pages) {
        if (includedIds.has(page.id)) continue;
        if (!accessibleSet.has(page.id)) continue;

        // Root page or top-level page in space export
        if (
          page.id === rootPageId ||
          (rootPageId === null && page.parentPageId === null)
        ) {
          includedIds.add(page.id);
          changed = true;
          continue;
        }

        // Non-root: include if parent is already included
        if (page.parentPageId && includedIds.has(page.parentPageId)) {
          includedIds.add(page.id);
          changed = true;
        }
      }
    }

    return pages.filter((p) => includedIds.has(p.id));
  }
}
