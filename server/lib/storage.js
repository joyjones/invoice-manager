import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const LEGACY_DB_FILE = path.join(DATA_DIR, 'invoices.json');

const DEFAULT_STORE = {
  meta: {
    version: 2,
    updatedAt: '',
  },
  documents: [],
  entries: [],
  ocrJobs: [],
};

function cloneDefaultStore() {
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureDataStore() {
  ensureDir(DATA_DIR);
  ensureDir(UPLOAD_DIR);
  if (!fs.existsSync(STORE_FILE)) {
    const initial = cloneDefaultStore();
    initial.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  }
}

function isValidStoreShape(parsed) {
  return (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray(parsed.documents) &&
    Array.isArray(parsed.entries) &&
    Array.isArray(parsed.ocrJobs)
  );
}

function normalizeStore(parsed) {
  if (isValidStoreShape(parsed)) {
    return {
      meta: {
        version: 2,
        updatedAt: parsed?.meta?.updatedAt || '',
      },
      documents: parsed.documents,
      entries: parsed.entries,
      ocrJobs: parsed.ocrJobs,
    };
  }

  if (parsed && Array.isArray(parsed.invoices)) {
    // Legacy migration: old invoices are treated as entries and documents.
    const now = new Date().toISOString();
    const documents = parsed.invoices.map((item) => ({
      id: item.id,
      sourcePath: item.filePath || '',
      originalName: item.fileName || '',
      storedFilePath: item.filePath || '',
      ext: path.extname(item.fileName || '').toLowerCase(),
      fileSize: 0,
      docCategory: item.status === 'OCR_SUCCESS' ? 'INVOICE' : 'OTHER',
      docSubType: item.invoiceType || 'UNKNOWN',
      processingStatus: item.status === 'OCR_SUCCESS' ? 'SUCCESS' : 'FAILED',
      createdAt: item.createdAt || now,
      importedAt: item.createdAt || now,
      title: item.title || item.invoiceType || '',
      tags: [],
      commonFields: {
        invoiceCode: item.invoiceCode || '',
        invoiceNumber: item.invoiceNumber || '',
        sellerName: item.sellerName || '',
        purchaserName: item.purchaserName || '',
      },
      extraFields: {
        migratedFromLegacy: true,
        rawData: item.rawData || {},
      },
    }));

    const entries = parsed.invoices
      .filter((item) => item.status === 'OCR_SUCCESS')
      .map((item) => ({
        id: `${item.id}-total`,
        documentId: item.id,
        sourceIndex: 0,
        entryType: 'INVOICE_TOTAL',
        expenseCategory: item.expenseType || '其他',
        expenseSubCategory: item.invoiceType || '',
        invoiceType: item.invoiceType || '',
        title: item.title || item.invoiceType || '',
        occurredDate: item.invoiceDate || '',
        invoiceDate: item.invoiceDate || '',
        createdAt: item.createdAt || now,
        amount: Number(item.amount) || 0,
        amountExcludingTax: null,
        taxAmount: null,
        currency: item.currency || 'CNY',
        merchantName: item.sellerName || '',
        sellerName: item.sellerName || '',
        sellerTaxNumber: item.sellerTaxNumber || '',
        purchaserName: item.purchaserName || '',
        purchaserTaxNumber: '',
        invoiceCode: item.invoiceCode || '',
        invoiceNumber: item.invoiceNumber || '',
        checkCode: '',
        machineCode: '',
        routeFrom: '',
        routeTo: '',
        travelerName: '',
        transportNo: '',
        seatClass: '',
        itemName: '',
        specification: '',
        unit: '',
        quantity: null,
        unitPrice: null,
        rawFields: item.rawData || {},
      }));

    const ocrJobs = parsed.invoices.map((item) => ({
      id: `${item.id}-legacy-job`,
      documentId: item.id,
      traceId: '',
      source: 'LEGACY_MIGRATION',
      status: item.status === 'OCR_SUCCESS' ? 'SUCCESS' : 'FAILED',
      startedAt: item.createdAt || now,
      endedAt: item.createdAt || now,
      elapsedMs: 0,
      actions: [],
      errorMessage: item.errorMessage || '',
      errorStack: '',
      createdAt: item.createdAt || now,
    }));

    return {
      meta: { version: 2, updatedAt: now },
      documents,
      entries,
      ocrJobs,
    };
  }

  return cloneDefaultStore();
}

function readStore() {
  ensureDataStore();
  const content = fs.readFileSync(STORE_FILE, 'utf-8');
  try {
    const parsed = JSON.parse(content);
    return normalizeStore(parsed);
  } catch {
    return cloneDefaultStore();
  }
}

function writeStore(store) {
  ensureDataStore();
  const normalized = normalizeStore(store);
  normalized.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
}

function clearUploads() {
  ensureDataStore();
  const files = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
  for (const file of files) {
    const target = path.join(UPLOAD_DIR, file.name);
    if (file.isFile()) {
      fs.unlinkSync(target);
    }
  }
}

function resetBusinessData() {
  ensureDataStore();
  clearUploads();
  const fresh = cloneDefaultStore();
  fresh.meta.updatedAt = new Date().toISOString();
  writeStore(fresh);
}

function upsertDocument(document) {
  const store = readStore();
  const index = store.documents.findIndex((item) => item.id === document.id);
  if (index >= 0) {
    store.documents[index] = document;
  } else {
    store.documents.push(document);
  }
  writeStore(store);
  return document;
}

function addOcrJob(job) {
  const store = readStore();
  store.ocrJobs.push(job);
  writeStore(store);
  return job;
}

function addEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  const store = readStore();
  store.entries.push(...entries);
  writeStore(store);
  return entries;
}

function addProcessResult({ document, entries = [], ocrJob }) {
  const store = readStore();
  const docIndex = store.documents.findIndex((item) => item.id === document.id);
  if (docIndex >= 0) {
    store.documents[docIndex] = document;
  } else {
    store.documents.push(document);
  }

  if (entries.length) {
    store.entries.push(...entries);
  }
  if (ocrJob) {
    store.ocrJobs.push(ocrJob);
  }
  writeStore(store);
  return { document, entries, ocrJob };
}

function compareDateDesc(a, b) {
  const aTime = dayjs(a).isValid() ? dayjs(a).valueOf() : 0;
  const bTime = dayjs(b).isValid() ? dayjs(b).valueOf() : 0;
  return bTime - aTime;
}

function queryDocuments({
  startDate,
  endDate,
  dateField = 'UPLOAD_DATE',
  docCategory,
  processingStatus,
  keyword,
  page = 1,
  pageSize = 20,
} = {}) {
  const store = readStore();
  const start = startDate && dayjs(startDate).isValid() ? dayjs(startDate).startOf('day') : null;
  const end = endDate && dayjs(endDate).isValid() ? dayjs(endDate).endOf('day') : null;
  const normalizedKeyword = keyword?.trim().toLowerCase();
  const useInvoiceDate = `${dateField}`.toUpperCase() === 'INVOICE_DATE';

  const filtered = store.documents.filter((item) => {
    const dateCandidate = useInvoiceDate
      ? (dayjs(item.commonFields?.invoiceDate).isValid()
          ? item.commonFields?.invoiceDate
          : item.createdAt)
      : item.createdAt;
    const itemDate = dayjs(dateCandidate).isValid() ? dayjs(dateCandidate) : dayjs(item.createdAt);

    if (start && itemDate.isBefore(start)) return false;
    if (end && itemDate.isAfter(end)) return false;
    if (docCategory && docCategory !== 'ALL' && item.docCategory !== docCategory) return false;
    if (
      processingStatus &&
      processingStatus !== 'ALL' &&
      item.processingStatus !== processingStatus
    ) {
      return false;
    }

    if (normalizedKeyword) {
      const haystack = [
        item.originalName,
        item.title,
        item.docCategory,
        item.docSubType,
        item.commonFields?.invoiceCode,
        item.commonFields?.invoiceNumber,
        item.commonFields?.sellerName,
        item.commonFields?.purchaserName,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedKeyword)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => compareDateDesc(a.createdAt, b.createdAt));

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const startIndex = (safePage - 1) * safePageSize;
  const items = filtered.slice(startIndex, startIndex + safePageSize);

  return {
    items,
    total: filtered.length,
    page: safePage,
    pageSize: safePageSize,
  };
}

function queryEntries({
  startDate,
  endDate,
  dateField = 'UPLOAD_DATE',
  type,
  expenseCategory,
  includeNonInvoice = false,
  keyword,
  page = 1,
  pageSize = 20,
} = {}) {
  const store = readStore();
  const start = startDate && dayjs(startDate).isValid() ? dayjs(startDate).startOf('day') : null;
  const end = endDate && dayjs(endDate).isValid() ? dayjs(endDate).endOf('day') : null;
  const normalizedKeyword = keyword?.trim().toLowerCase();
  const useInvoiceDate = `${dateField}`.toUpperCase() === 'INVOICE_DATE';

  const filtered = store.entries.filter((item) => {
    if (!includeNonInvoice && !`${item.entryType || ''}`.startsWith('INVOICE')) {
      return false;
    }
    const itemDate = useInvoiceDate
      ? (dayjs(item.occurredDate).isValid() ? dayjs(item.occurredDate) : dayjs(item.createdAt))
      : dayjs(item.createdAt);

    if (start && itemDate.isBefore(start)) return false;
    if (end && itemDate.isAfter(end)) return false;
    if (type && type !== 'ALL' && item.invoiceType !== type) return false;
    if (expenseCategory && expenseCategory !== 'ALL' && item.expenseCategory !== expenseCategory) {
      return false;
    }

    if (normalizedKeyword) {
      const haystack = [
        item.title,
        item.invoiceType,
        item.expenseCategory,
        item.expenseSubCategory,
        item.invoiceCode,
        item.invoiceNumber,
        item.sellerName,
        item.merchantName,
        item.purchaserName,
        item.itemName,
        item.travelerName,
        item.routeFrom,
        item.routeTo,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedKeyword)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => compareDateDesc(a.createdAt, b.createdAt));

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const startIndex = (safePage - 1) * safePageSize;
  const items = filtered.slice(startIndex, startIndex + safePageSize);
  const totalAmount = filtered.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  return {
    items,
    total: filtered.length,
    page: safePage,
    pageSize: safePageSize,
    totalAmount: Number(totalAmount.toFixed(2)),
  };
}

function queryOcrJobs({
  status,
  keyword,
  page = 1,
  pageSize = 50,
} = {}) {
  const store = readStore();
  const normalizedKeyword = keyword?.trim().toLowerCase();

  const filtered = store.ocrJobs.filter((item) => {
    if (status && status !== 'ALL' && item.status !== status) {
      return false;
    }
    if (normalizedKeyword) {
      const haystack = [
        item.traceId,
        item.source,
        item.status,
        item.errorMessage,
        ...(item.actions || []).map((action) => `${action.name} ${action.requestId || ''}`),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedKeyword)) {
        return false;
      }
    }
    return true;
  });

  filtered.sort((a, b) => compareDateDesc(a.startedAt, b.startedAt));

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 50);
  const startIndex = (safePage - 1) * safePageSize;
  const items = filtered.slice(startIndex, startIndex + safePageSize);

  return {
    items,
    total: filtered.length,
    page: safePage,
    pageSize: safePageSize,
  };
}

function listInvoiceTypes() {
  const store = readStore();
  return [...new Set(store.entries.map((item) => item.invoiceType).filter(Boolean))].sort();
}

function listExpenseCategories() {
  const store = readStore();
  return [...new Set(store.entries.map((item) => item.expenseCategory).filter(Boolean))].sort();
}

function getStoreStats() {
  const store = readStore();
  return {
    documents: store.documents.length,
    entries: store.entries.length,
    ocrJobs: store.ocrJobs.length,
    lastUpdatedAt: store.meta.updatedAt || '',
  };
}

export {
  DATA_DIR,
  LEGACY_DB_FILE,
  ROOT_DIR,
  STORE_FILE,
  UPLOAD_DIR,
  addEntries,
  addOcrJob,
  addProcessResult,
  clearUploads,
  ensureDataStore,
  getStoreStats,
  listExpenseCategories,
  listInvoiceTypes,
  queryDocuments,
  queryEntries,
  queryOcrJobs,
  readStore,
  resetBusinessData,
  upsertDocument,
  writeStore,
};
