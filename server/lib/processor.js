import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { createLogger, normalizeError } from './logger.js';
import { normalizeDocxSummary, normalizeRecognizedDocument } from './normalize.js';
import { recognizeDocumentFromFile } from './ocr.js';
import { UPLOAD_DIR } from './storage.js';

const OCR_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const DOCX_EXTENSION = '.docx';

function guessMimeType(ext) {
  const map = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeFileName(fileName = '') {
  return `${fileName}`.replace(/[\\/:*?"<>|]+/g, '_');
}

function buildStoredFileName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.bin';
  const name = path.basename(originalName || 'file', ext);
  const safeName = sanitizeFileName(name).slice(0, 80) || 'file';
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}${ext}`;
}

function copyIntoUploads(sourcePath, originalName) {
  const storedName = buildStoredFileName(originalName || path.basename(sourcePath));
  const targetPath = path.join(UPLOAD_DIR, storedName);
  fs.copyFileSync(sourcePath, targetPath);
  return {
    storedName,
    targetPath,
    storedFilePath: `/uploads/${storedName}`,
  };
}

async function parseDocxText(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return (result?.value || '').trim();
  } catch {
    return '';
  }
}

function buildSkippedDocument({
  documentId,
  originalName,
  sourcePath,
  storedFilePath,
  ext,
  fileSize,
  createdAt,
  reason,
}) {
  return {
    documentId,
    document: {
      id: documentId,
      sourcePath,
      originalName,
      storedFilePath,
      ext,
      fileSize,
      docCategory: 'OTHER',
      docSubType: 'UNSUPPORTED',
      processingStatus: 'SKIPPED',
      title: originalName,
      tags: ['OTHER', 'UNSUPPORTED'],
      commonFields: {
        invoiceType: '非识别文件',
        invoiceDate: '',
        amount: null,
        amountExcludingTax: null,
        taxAmount: null,
        currency: 'CNY',
        invoiceCode: '',
        invoiceNumber: '',
        checkCode: '',
        machineCode: '',
        sellerName: '',
        sellerTaxNumber: '',
        purchaserName: '',
        purchaserTaxNumber: '',
        routeFrom: '',
        routeTo: '',
        travelerName: '',
        transportNo: '',
        seatClass: '',
        expenseCategory: '其他',
      },
      extraFields: {
        reason,
      },
      createdAt,
      importedAt: createdAt,
    },
    entries: [],
    ocrJob: {
      id: crypto.randomUUID(),
      documentId,
      traceId: '',
      source: 'SKIPPED',
      status: 'SKIPPED',
      startedAt: createdAt,
      endedAt: createdAt,
      elapsedMs: 0,
      actions: [
        {
          name: 'Skipped',
          statusCode: 0,
          providerCode: '',
          requestId: '',
          message: reason,
          hasData: false,
          elapsedMs: 0,
        },
      ],
      errorMessage: '',
      errorStack: '',
      createdAt,
    },
  };
}

async function processStoredFile({
  documentId: providedDocumentId,
  sourcePath,
  originalName,
  storedFilePath,
  absoluteFilePath,
  traceId,
}) {
  const documentId = providedDocumentId || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const ext = path.extname(originalName || absoluteFilePath).toLowerCase();
  const fileSize = fs.existsSync(absoluteFilePath) ? fs.statSync(absoluteFilePath).size : 0;
  const logger = createLogger('processor', {
    traceId,
    documentId,
    fileName: originalName,
    ext,
  });

  if (ext === DOCX_EXTENSION) {
    const startedAt = Date.now();
    const plainText = await parseDocxText(absoluteFilePath);
    const normalized = normalizeDocxSummary({
      documentId,
      fileName: originalName,
      createdAt,
      plainText,
    });

    logger.info('DOCX 解析完成', {
      textLength: plainText.length,
      docSubType: normalized.docSubType,
    });

    return {
      documentId,
      document: {
        id: documentId,
        sourcePath,
        originalName,
        storedFilePath,
        ext,
        mimeType: guessMimeType(ext),
        fileSize,
        docCategory: normalized.docCategory,
        docSubType: normalized.docSubType,
        processingStatus: 'SUCCESS',
        title: normalized.title,
        tags: normalized.tags,
        commonFields: normalized.commonFields,
        extraFields: normalized.extraFields,
        createdAt,
        importedAt: createdAt,
      },
      entries: normalized.entries,
      ocrJob: {
        id: crypto.randomUUID(),
        documentId,
        traceId,
        source: 'DOCX_TEXT',
        status: 'SUCCESS',
        startedAt: createdAt,
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        actions: [
          {
            name: 'ParseDocx',
            statusCode: 200,
            providerCode: 'OK',
            requestId: '',
            message: '',
            hasData: plainText.length > 0,
            elapsedMs: Date.now() - startedAt,
          },
        ],
        errorMessage: '',
        errorStack: '',
        createdAt,
      },
    };
  }

  if (!OCR_EXTENSIONS.has(ext)) {
    return buildSkippedDocument({
      documentId,
      originalName,
      sourcePath,
      storedFilePath,
      ext,
      fileSize,
      createdAt,
      reason: `暂不支持识别该文件类型: ${ext || 'unknown'}`,
    });
  }

  const startedAt = Date.now();
  const ocrResult = await recognizeDocumentFromFile(absoluteFilePath, {
    traceId,
    documentId,
    fileName: originalName,
  });

  if (!ocrResult.success) {
    logger.warn('OCR 识别失败', {
      errorMessage: ocrResult.errorMessage,
    });
    return {
      documentId,
      document: {
        id: documentId,
        sourcePath,
        originalName,
        storedFilePath,
        ext,
        mimeType: guessMimeType(ext),
        fileSize,
        docCategory: 'OTHER',
        docSubType: 'UNKNOWN',
        processingStatus: 'FAILED',
        title: originalName,
        tags: ['OCR_FAILED'],
        commonFields: {
          invoiceType: '识别失败',
          invoiceDate: '',
          amount: null,
          amountExcludingTax: null,
          taxAmount: null,
          currency: 'CNY',
          invoiceCode: '',
          invoiceNumber: '',
          checkCode: '',
          machineCode: '',
          sellerName: '',
          sellerTaxNumber: '',
          purchaserName: '',
          purchaserTaxNumber: '',
          routeFrom: '',
          routeTo: '',
          travelerName: '',
          transportNo: '',
          seatClass: '',
          expenseCategory: '其他',
        },
        extraFields: {
          providerMessage: ocrResult.providerMessage || '',
          rawPayload: ocrResult.raw || {},
        },
        createdAt,
        importedAt: createdAt,
      },
      entries: [],
      ocrJob: {
        id: crypto.randomUUID(),
        documentId,
        traceId,
        source: 'ALIYUN_OCR',
        status: 'FAILED',
        startedAt: createdAt,
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        actions: ocrResult.actions || [],
        errorMessage: ocrResult.errorMessage || ocrResult.providerMessage || 'OCR 识别失败',
        errorStack: '',
        createdAt,
      },
    };
  }

  const normalized = normalizeRecognizedDocument({
    documentId,
    fileName: originalName,
    ext,
    createdAt,
    rawPayload: ocrResult.raw,
  });

  const processingStatus =
    normalized.docCategory === 'INVOICE' || normalized.docCategory === 'SUMMARY'
      ? 'SUCCESS'
      : normalized.entries.length > 0
        ? 'SUCCESS'
        : 'PARTIAL';

  logger.info('OCR 识别成功', {
    usedAction: ocrResult.usedAction,
    docCategory: normalized.docCategory,
    docSubType: normalized.docSubType,
    entries: normalized.entries.length,
  });

  return {
    documentId,
    document: {
      id: documentId,
      sourcePath,
      originalName,
      storedFilePath,
      ext,
      mimeType: guessMimeType(ext),
      fileSize,
      docCategory: normalized.docCategory,
      docSubType: normalized.docSubType,
      processingStatus,
      title: normalized.title,
      tags: normalized.tags,
      commonFields: normalized.commonFields,
      extraFields: {
        ...normalized.extraFields,
        usedAction: ocrResult.usedAction,
        providerRequestId: ocrResult.providerRequestId || '',
        providerCode: ocrResult.providerCode || '',
        providerMessage: ocrResult.providerMessage || '',
      },
      createdAt,
      importedAt: createdAt,
    },
    entries: normalized.entries,
    ocrJob: {
      id: crypto.randomUUID(),
      documentId,
      traceId,
      source: 'ALIYUN_OCR',
      status: processingStatus === 'SUCCESS' ? 'SUCCESS' : 'PARTIAL',
      startedAt: createdAt,
      endedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      actions: ocrResult.actions || [],
      errorMessage: '',
      errorStack: '',
      createdAt,
    },
  };
}

async function importFileFromPath({ absolutePath, sourceRoot = '' }) {
  const originalName = path.basename(absolutePath);
  const copied = copyIntoUploads(absolutePath, originalName);
  const traceId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const sourcePath = sourceRoot
    ? path.relative(sourceRoot, absolutePath).replace(/\\/g, '/')
    : absolutePath;

  try {
    return await processStoredFile({
      sourcePath,
      originalName,
      storedFilePath: copied.storedFilePath,
      absoluteFilePath: copied.targetPath,
      traceId,
      documentId,
    });
  } catch (error) {
    const createdAt = new Date().toISOString();
    return {
      documentId,
      document: {
        id: documentId,
        sourcePath,
        originalName,
        storedFilePath: copied.storedFilePath,
        ext: path.extname(originalName).toLowerCase(),
        mimeType: guessMimeType(path.extname(originalName).toLowerCase()),
        fileSize: fs.existsSync(copied.targetPath) ? fs.statSync(copied.targetPath).size : 0,
        docCategory: 'OTHER',
        docSubType: 'UNKNOWN',
        processingStatus: 'FAILED',
        title: originalName,
        tags: ['IMPORT_FAILED'],
        commonFields: {
          invoiceType: '导入失败',
          invoiceDate: '',
          amount: null,
          amountExcludingTax: null,
          taxAmount: null,
          currency: 'CNY',
          invoiceCode: '',
          invoiceNumber: '',
          checkCode: '',
          machineCode: '',
          sellerName: '',
          sellerTaxNumber: '',
          purchaserName: '',
          purchaserTaxNumber: '',
          routeFrom: '',
          routeTo: '',
          travelerName: '',
          transportNo: '',
          seatClass: '',
          expenseCategory: '其他',
        },
        extraFields: {
          error: normalizeError(error),
        },
        createdAt,
        importedAt: createdAt,
      },
      entries: [],
      ocrJob: {
        id: crypto.randomUUID(),
        documentId,
        traceId,
        source: 'IMPORT_PIPELINE',
        status: 'FAILED',
        startedAt: createdAt,
        endedAt: createdAt,
        elapsedMs: 0,
        actions: [],
        errorMessage: error instanceof Error ? error.message : `${error}`,
        errorStack: error instanceof Error ? error.stack || '' : '',
        createdAt,
      },
    };
  }
}

function collectFilesRecursively(rootDir) {
  const results = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('~$')) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  results.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return results;
}

export {
  OCR_EXTENSIONS,
  collectFilesRecursively,
  copyIntoUploads,
  importFileFromPath,
  parseDocxText,
  processStoredFile,
};
