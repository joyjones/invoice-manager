import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import dayjs from 'dayjs';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { LOG_DIR, createLogger, logger, normalizeError } from './lib/logger.js';
import { processStoredFile } from './lib/processor.js';
import {
  ROOT_DIR,
  UPLOAD_DIR,
  addProcessResult,
  createManualNonSelfPaidEntry,
  deleteEntriesByIds,
  ensureDataStore,
  getStoreStats,
  listExpenseCategories,
  listInvoiceTypes,
  queryDocuments,
  queryEntries,
  queryOcrJobs,
  updateEntriesRegion,
  updateEntryById,
} from './lib/storage.js';

dotenv.config();
ensureDataStore();

const app = express();
const port = Number(process.env.PORT || 3001);
const appLogger = logger.child({ module: 'app' });

const allowedExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const allowedMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'application/octet-stream',
]);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

app.use((req, res, next) => {
  const traceId = req.get('x-request-id') || crypto.randomUUID();
  req.traceId = traceId;
  res.setHeader('x-request-id', traceId);
  req.logger = createLogger('http', {
    traceId,
    method: req.method,
    path: req.originalUrl,
  });
  const startedAt = Date.now();
  req.logger.info('请求开始', {
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
  });
  res.on('finish', () => {
    req.logger.info('请求结束', {
      statusCode: res.statusCode,
      elapsedMs: Date.now() - startedAt,
    });
  });
  next();
});

const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 40 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.has(ext) && (allowedMimeTypes.has(file.mimetype) || !file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error(`仅支持发票文件（PDF/JPG/JPEG/PNG/WEBP/BMP），收到: ${ext || file.mimetype}`));
  },
});

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUploadedFileName(originalName = '') {
  if (!originalName) return '';
  if (/[\u4e00-\u9fff]/.test(originalName)) return originalName;
  try {
    const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
    if (/[\u4e00-\u9fff]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // keep original
  }
  return originalName;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // no-op
  }
}

function readQueryRange(query) {
  const now = dayjs();
  return {
    startDate: `${query.startDate || now.startOf('month').format('YYYY-MM-DD')}`,
    endDate: `${query.endDate || now.endOf('month').format('YYYY-MM-DD')}`,
  };
}

function formatRoute(item = {}) {
  return [item.routeFrom, item.routeTo].filter(Boolean).join(' -> ');
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    stats: getStoreStats(),
  });
});

async function handleUpload(req, res) {
  const files = req.files || [];
  const log = (req.logger || appLogger).child({
    route: req.originalUrl,
    fileCount: files.length,
  });

  if (!files.length) {
    log.warn('上传请求未包含文件');
    res.status(400).json({ message: '请至少上传一个文件（字段名: files）', traceId: req.traceId });
    return;
  }

  log.info('开始处理上传文件');

  const documents = [];
  const allEntries = [];
  const ignoredFiles = [];
  const failedFiles = [];

  for (const file of files) {
    const originalName = normalizeUploadedFileName(file.originalname);
    const fileLog = log.child({ fileName: originalName, size: file.size, mimeType: file.mimetype });

    try {
      const result = await processStoredFile({
        sourcePath: `upload/${originalName}`,
        originalName,
        storedFilePath: `/uploads/${file.filename}`,
        absoluteFilePath: file.path,
        traceId: req.traceId,
      });

      if (result.document.processingStatus === 'FAILED') {
        const reason =
          result.ocrJob?.errorMessage ||
          result.document.extraFields?.providerMessage ||
          '发票识别失败';
        failedFiles.push({ fileName: originalName, reason });
        safeUnlink(file.path);
        fileLog.warn('文件识别失败，未导入', { reason });
        continue;
      }

      if (result.document.docCategory !== 'INVOICE') {
        const reason = `识别结果为 ${result.document.docCategory || 'OTHER'}，非发票`;
        ignoredFiles.push({ fileName: originalName, reason });
        safeUnlink(file.path);
        fileLog.info('非发票文件，已忽略', {
          docCategory: result.document.docCategory,
          docSubType: result.document.docSubType,
        });
        continue;
      }

      if (!result.entries.length) {
        const reason = '已识别为发票，但未抽取到可用费用条目';
        ignoredFiles.push({ fileName: originalName, reason });
        safeUnlink(file.path);
        fileLog.warn('发票未抽取到条目，已忽略', { reason });
        continue;
      }

      addProcessResult(result);
      documents.push(result.document);
      allEntries.push(...result.entries);

      fileLog.info('发票导入完成', {
        processingStatus: result.document.processingStatus,
        docCategory: result.document.docCategory,
        entryCount: result.entries.length,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : `${error || '处理异常'}`;
      failedFiles.push({ fileName: originalName, reason });
      safeUnlink(file.path);
      fileLog.error('上传文件处理异常', {
        error: normalizeError(error),
      });
    }
  }

  const successCount = documents.length;
  const ignoredCount = ignoredFiles.length;
  const failedCount = failedFiles.length;

  res.json({
    message: `处理完成，共 ${files.length} 个文件，成功导入 ${successCount} 个发票，忽略非发票 ${ignoredCount} 个，失败 ${failedCount} 个`,
    traceId: req.traceId,
    totalFileCount: files.length,
    successCount,
    failedCount,
    failCount: failedCount,
    ignoredCount,
    documentCount: documents.length,
    entryCount: allEntries.length,
    ignoredFiles,
    failedFiles,
    stats: getStoreStats(),
    documents,
  });
}

app.post('/api/invoices/upload', upload.array('files', 50), handleUpload);
app.post('/api/documents/upload', upload.array('files', 50), handleUpload);

app.get('/api/invoices/types', (_req, res) => {
  res.json({ items: listInvoiceTypes() });
});

app.get('/api/expenses/categories', (_req, res) => {
  res.json({ items: listExpenseCategories() });
});

app.get('/api/documents', (req, res) => {
  const { startDate, endDate } = readQueryRange(req.query);
  const { dateField = 'UPLOAD_DATE', docCategory, processingStatus, keyword, page = 1, pageSize = 20 } =
    req.query;

  const result = queryDocuments({
    startDate,
    endDate,
    dateField,
    docCategory,
    processingStatus,
    keyword,
    page: toSafeNumber(page, 1),
    pageSize: toSafeNumber(pageSize, 20),
  });

  res.json(result);
});

app.get('/api/entries', (req, res) => {
  const { startDate, endDate } = readQueryRange(req.query);
  const {
    dateField = 'UPLOAD_DATE',
    type,
    expenseCategory,
    includeNonInvoice,
    keyword,
    page = 1,
    pageSize = 20,
  } = req.query;

  const result = queryEntries({
    startDate,
    endDate,
    dateField,
    type,
    expenseCategory,
    includeNonInvoice: `${includeNonInvoice || ''}`.toLowerCase() === 'true',
    keyword,
    page: toSafeNumber(page, 1),
    pageSize: toSafeNumber(pageSize, 20),
  });

  res.json(result);
});

app.delete('/api/entries', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) {
    res.status(400).json({ message: '请先选择要删除的发票条目', traceId: req.traceId || '' });
    return;
  }

  const result = deleteEntriesByIds(ids);
  res.json({
    message: `删除完成：条目 ${result.deletedEntryCount} 条，文档 ${result.deletedDocumentCount} 个`,
    traceId: req.traceId || '',
    ...result,
    stats: getStoreStats(),
  });
});

app.post('/api/entries/manual', (req, res) => {
  const payload = req.body || {};
  const occurredDate = `${payload.occurredDate || ''}`.trim();
  const expenseCategory = `${payload.expenseCategory || ''}`.trim();
  const itemName = `${payload.itemName || ''}`.trim();
  const amount = Number(payload.amount);

  if (!occurredDate || !expenseCategory || !itemName || !Number.isFinite(amount)) {
    res.status(400).json({
      message: '请完整填写发生日期、分类、金额、明细项',
      traceId: req.traceId || '',
    });
    return;
  }

  const created = createManualNonSelfPaidEntry({
    occurredDate,
    expenseCategory,
    amount,
    itemName,
    occurredRegion: `${payload.occurredRegion || ''}`.trim(),
  });

  if (!created) {
    res.status(400).json({
      message: '新增非自费项失败，请检查输入内容',
      traceId: req.traceId || '',
    });
    return;
  }

  res.json({
    message: '新增非自费项成功',
    traceId: req.traceId || '',
    item: created,
    stats: getStoreStats(),
  });
});

app.put('/api/entries/region', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const region = `${req.body?.region || ''}`.trim();

  if (!ids.length) {
    res.status(400).json({ message: '请先选择至少一条票据', traceId: req.traceId || '' });
    return;
  }
  if (!region) {
    res.status(400).json({ message: '发生地区不能为空', traceId: req.traceId || '' });
    return;
  }

  const result = updateEntriesRegion(ids, region);
  res.json({
    message: `地区更新完成：共更新 ${result.updatedCount} 条`,
    traceId: req.traceId || '',
    ...result,
    stats: getStoreStats(),
  });
});

app.put('/api/entries/:id', (req, res) => {
  const entryId = `${req.params?.id || ''}`.trim();
  if (!entryId) {
    res.status(400).json({ message: '缺少票据条目 ID', traceId: req.traceId || '' });
    return;
  }

  const result = updateEntryById(entryId, req.body || {});
  if (!result) {
    res.status(404).json({ message: '未找到要编辑的票据条目', traceId: req.traceId || '' });
    return;
  }

  const dedupHint = result.removedDuplicateCount > 0 ? `，并清理重复条目 ${result.removedDuplicateCount} 条` : '';
  res.json({
    message: `编辑成功${dedupHint}`,
    traceId: req.traceId || '',
    item: result.item,
    removedDuplicateCount: result.removedDuplicateCount,
    stats: getStoreStats(),
  });
});

// Backward compatible route.
app.get('/api/invoices', (req, res) => {
  const { startDate, endDate } = readQueryRange(req.query);
  const {
    dateField = 'UPLOAD_DATE',
    type,
    expenseCategory,
    keyword,
    page = 1,
    pageSize = 20,
  } = req.query;

  const result = queryEntries({
    startDate,
    endDate,
    dateField,
    type,
    expenseCategory,
    includeNonInvoice: false,
    keyword,
    page: toSafeNumber(page, 1),
    pageSize: toSafeNumber(pageSize, 20),
  });

  res.json(result);
});

app.get('/api/ocr-jobs', (req, res) => {
  const { status, keyword, page = 1, pageSize = 50 } = req.query;
  const result = queryOcrJobs({
    status,
    keyword,
    page: toSafeNumber(page, 1),
    pageSize: toSafeNumber(pageSize, 50),
  });
  res.json(result);
});

app.get('/api/invoices/export', (req, res) => {
  const { startDate, endDate } = readQueryRange(req.query);
  const { dateField = 'INVOICE_DATE', type, expenseCategory, keyword } = req.query;

  const queryResult = queryEntries({
    startDate,
    endDate,
    dateField,
    type,
    expenseCategory,
    includeNonInvoice: false,
    keyword,
    page: 1,
    pageSize: 100000,
  });

  const mergeInvoiceNo = (item) => {
    const number = `${item?.invoiceNumber || ''}`.trim();
    const code = `${item?.invoiceCode || ''}`.trim();
    if (number && code) return `${number}（代码:${code}）`;
    return number || code;
  };

  const rows = queryResult.items.map((item, index) => ({
    序号: index + 1,
    上传时间: dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss'),
    发生日期: item.occurredDate,
    发票类型: item.invoiceType,
    费用分类: item.expenseCategory,
    子分类: item.expenseSubCategory,
    金额: item.amount,
    未税金额: item.amountExcludingTax,
    税额: item.taxAmount,
    币种: item.currency,
    销售方: item.sellerName,
    购买方: item.purchaserName,
    发票号码: mergeInvoiceNo(item),
    线路: formatRoute(item),
    乘车人: item.travelerName,
    明细项: item.itemName,
  }));

  rows.push({
    序号: '',
    上传时间: '',
    发生日期: '',
    发票类型: '',
    费用分类: '',
    子分类: '',
    金额: queryResult.totalAmount,
    未税金额: '',
    税额: '',
    币种: 'CNY',
    销售方: '',
    购买方: '',
    发票号码: '总计',
    线路: '',
    乘车人: '',
    明细项: '',
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '费用报表');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `travel-expense-${startDate}-to-${endDate}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

app.get('/api/invoices/export-summary', (req, res) => {
  const { startDate, endDate } = readQueryRange(req.query);
  const { dateField = 'INVOICE_DATE', type, expenseCategory, keyword } = req.query;

  const queryResult = queryEntries({
    startDate,
    endDate,
    dateField,
    type,
    expenseCategory,
    includeNonInvoice: true,
    keyword,
    page: 1,
    pageSize: 100000,
  });

  const rows = queryResult.items.map((item, index) => ({
    序号: index + 1,
    发生日期: item.occurredDate || '',
    发生地区: item.occurredRegion || '',
    自费: item.selfPaid ? '是' : '否',
    费用分类: item.expenseCategory || '',
    金额: Number(item.amount || 0),
    销售方: item.sellerName || '',
    线路: formatRoute(item),
    明细项: item.itemName || '',
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '票据报表');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `invoice-summary-${startDate}-to-${endDate}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

app.use((error, req, res, _next) => {
  const message = error instanceof Error ? error.message : '服务器错误';
  (req.logger || appLogger).error('请求处理异常', {
    error: normalizeError(error),
  });
  res.status(400).json({ message, traceId: req.traceId || '' });
});

const webDist = path.resolve(ROOT_DIR, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.listen(port, () => {
  appLogger.info('服务启动成功', {
    port,
    logDir: LOG_DIR,
    logLevel: process.env.LOG_LEVEL || 'info',
    stats: getStoreStats(),
  });
});

process.on('unhandledRejection', (reason) => {
  appLogger.error('未处理的 Promise 拒绝', {
    error: normalizeError(reason),
  });
});

process.on('uncaughtException', (error) => {
  appLogger.error('未捕获异常', {
    error: normalizeError(error),
  });
});
