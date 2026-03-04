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
  ensureDataStore,
  getStoreStats,
  listExpenseCategories,
  listInvoiceTypes,
  queryDocuments,
  queryEntries,
  queryOcrJobs,
} from './lib/storage.js';

dotenv.config();
ensureDataStore();

const app = express();
const port = Number(process.env.PORT || 3000);
const appLogger = logger.child({ module: 'app' });

const allowedExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.docx']);
const allowedMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
    if (allowedExtensions.has(ext) && allowedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error(`暂不支持该文件类型: ${ext || file.mimetype}`));
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

function readQueryRange(query) {
  const now = dayjs();
  return {
    startDate: `${query.startDate || now.startOf('month').format('YYYY-MM-DD')}`,
    endDate: `${query.endDate || now.endOf('month').format('YYYY-MM-DD')}`,
  };
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
  const jobs = [];

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

      addProcessResult(result);
      documents.push(result.document);
      allEntries.push(...result.entries);
      jobs.push(result.ocrJob);

      fileLog.info('文件处理完成', {
        processingStatus: result.document.processingStatus,
        docCategory: result.document.docCategory,
        entryCount: result.entries.length,
      });
    } catch (error) {
      fileLog.error('上传文件处理异常', {
        error: normalizeError(error),
      });
    }
  }

  const successCount = documents.filter((item) => item.processingStatus === 'SUCCESS').length;

  res.json({
    message: `处理完成，共 ${documents.length} 个文件，成功 ${successCount} 个`,
    traceId: req.traceId,
    successCount,
    failCount: documents.length - successCount,
    documentCount: documents.length,
    entryCount: allEntries.length,
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
    发票代码: item.invoiceCode,
    发票号码: item.invoiceNumber,
    线路: [item.routeFrom, item.routeTo].filter(Boolean).join('->'),
    交通号次: item.transportNo,
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
    发票代码: '',
    发票号码: '总计',
    线路: '',
    交通号次: '',
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
