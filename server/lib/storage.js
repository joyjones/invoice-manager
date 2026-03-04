import crypto from 'node:crypto';
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

const ENTRY_NUMERIC_FIELDS = new Set([
  'amount',
  'amountExcludingTax',
  'taxAmount',
  'quantity',
  'unitPrice',
  'sourceIndex',
]);
const ENTRY_BOOLEAN_FIELDS = new Set(['selfPaid']);

const ENTRY_DATE_FIELDS = new Set(['occurredDate', 'invoiceDate']);
const ENTRY_DATETIME_FIELDS = new Set(['createdAt']);
const ENTRY_EDITABLE_FIELDS = new Set([
  'sourceIndex',
  'entryType',
  'expenseCategory',
  'expenseSubCategory',
  'invoiceType',
  'title',
  'occurredDate',
  'invoiceDate',
  'createdAt',
  'amount',
  'amountExcludingTax',
  'taxAmount',
  'currency',
  'merchantName',
  'sellerName',
  'sellerTaxNumber',
  'purchaserName',
  'purchaserTaxNumber',
  'invoiceCode',
  'invoiceNumber',
  'selfPaid',
  'occurredRegion',
  'checkCode',
  'machineCode',
  'routeFrom',
  'routeTo',
  'travelerName',
  'seatClass',
  'itemName',
  'specification',
  'unit',
  'quantity',
  'unitPrice',
]);

function normalizeText(value) {
  return `${value ?? ''}`.trim();
}

function mergeRouteToWithTransport(routeTo, transportNo) {
  const routeValue = normalizeText(routeTo);
  const transportValue = normalizeText(transportNo);
  if (!transportValue) return routeValue;
  if (!routeValue) return transportValue;
  if (routeValue.includes(transportValue)) return routeValue;
  return `${routeValue}（${transportValue}）`;
}

function normalizeSelfPaid(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  const text = `${value}`.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function normalizeEntryRecord(entry = {}) {
  const { transportNo: _transportNo, ...rest } = entry || {};
  const fallbackSelfPaid = `${entry.entryType || ''}` === 'INVOICE_MANUAL' ? false : true;
  const routeTo = mergeRouteToWithTransport(entry.routeTo, entry.transportNo);
  const invoiceNumber = normalizeInvoiceNumber(entry.invoiceNumber);

  return {
    ...rest,
    invoiceNumber,
    routeFrom: normalizeText(entry.routeFrom),
    routeTo,
    selfPaid: normalizeSelfPaid(entry.selfPaid, fallbackSelfPaid),
    occurredRegion: normalizeText(entry.occurredRegion),
  };
}

function normalizeDocumentRecord(document = {}) {
  const commonFields = document?.commonFields || {};
  const routeTo = mergeRouteToWithTransport(commonFields.routeTo, commonFields.transportNo);
  const { transportNo: _transportNo, ...restCommonFields } = commonFields;
  return {
    ...document,
    commonFields: {
      ...restCommonFields,
      routeTo,
      occurredRegion: normalizeText(commonFields.occurredRegion),
    },
  };
}

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
      documents: parsed.documents.map((item) => normalizeDocumentRecord(item)),
      entries: parsed.entries.map((item) => normalizeEntryRecord(item)),
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
        selfPaid: true,
        occurredRegion: '',
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
  const normalizedDocument = normalizeDocumentRecord(document);
  const store = readStore();
  const index = store.documents.findIndex((item) => item.id === normalizedDocument.id);
  if (index >= 0) {
    store.documents[index] = normalizedDocument;
  } else {
    store.documents.push(normalizedDocument);
  }
  writeStore(store);
  return normalizedDocument;
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
  store.entries.push(...entries.map((item) => normalizeEntryRecord(item)));
  writeStore(store);
  return entries;
}

function normalizeInvoiceNumber(value = '') {
  return `${value || ''}`.trim();
}

function pickPreferredEntry(current, candidate) {
  const currentIsTotal = `${current?.entryType || ''}` === 'INVOICE_TOTAL';
  const candidateIsTotal = `${candidate?.entryType || ''}` === 'INVOICE_TOTAL';
  if (candidateIsTotal && !currentIsTotal) return candidate;
  if (!candidateIsTotal && currentIsTotal) return current;

  const currentAmount = Number(current?.amount || 0);
  const candidateAmount = Number(candidate?.amount || 0);
  return Math.abs(candidateAmount) >= Math.abs(currentAmount) ? candidate : current;
}

function collapseIncomingEntries(entries = []) {
  const grouped = new Map();
  const noInvoiceNumber = [];

  for (const entry of entries) {
    const invoiceNumber = normalizeInvoiceNumber(entry?.invoiceNumber);
    if (!invoiceNumber) {
      noInvoiceNumber.push(entry);
      continue;
    }
    const existing = grouped.get(invoiceNumber);
    grouped.set(invoiceNumber, existing ? pickPreferredEntry(existing, entry) : entry);
  }

  return [...noInvoiceNumber, ...grouped.values()].map((entry) => normalizeEntryRecord({
    ...entry,
    invoiceNumber: normalizeInvoiceNumber(entry?.invoiceNumber),
  }));
}

function upsertEntriesByInvoiceNumber(store, entries = []) {
  const normalizedEntries = collapseIncomingEntries(entries);
  const upsertedEntries = [];

  for (const incoming of normalizedEntries) {
    const invoiceNumber = normalizeInvoiceNumber(incoming.invoiceNumber);
    if (!invoiceNumber) {
      const existingIndex = store.entries.findIndex((item) => item.id === incoming.id);
      if (existingIndex >= 0) {
        store.entries[existingIndex] = normalizeEntryRecord({ ...store.entries[existingIndex], ...incoming });
        upsertedEntries.push(store.entries[existingIndex]);
      } else {
        const created = normalizeEntryRecord(incoming);
        store.entries.push(created);
        upsertedEntries.push(created);
      }
      continue;
    }

    const duplicatedIndexes = [];
    for (let index = 0; index < store.entries.length; index += 1) {
      if (normalizeInvoiceNumber(store.entries[index].invoiceNumber) === invoiceNumber) {
        duplicatedIndexes.push(index);
      }
    }

    if (!duplicatedIndexes.length) {
      const nextEntry = normalizeEntryRecord({ ...incoming, invoiceNumber });
      store.entries.push(nextEntry);
      upsertedEntries.push(nextEntry);
      continue;
    }

    const primaryIndex = duplicatedIndexes[0];
    const primary = store.entries[primaryIndex];
    const merged = {
      ...primary,
      ...incoming,
      id: primary.id || incoming.id,
      invoiceNumber,
    };
    store.entries[primaryIndex] = normalizeEntryRecord(merged);

    for (let i = duplicatedIndexes.length - 1; i >= 1; i -= 1) {
      store.entries.splice(duplicatedIndexes[i], 1);
    }
    upsertedEntries.push(merged);
  }

  return upsertedEntries;
}

function addProcessResult({ document, entries = [], ocrJob }) {
  const store = readStore();
  const normalizedDocument = normalizeDocumentRecord(document);
  const docIndex = store.documents.findIndex((item) => item.id === document.id);
  if (docIndex >= 0) {
    store.documents[docIndex] = normalizedDocument;
  } else {
    store.documents.push(normalizedDocument);
  }

  const normalizedEntries = entries.map((item) => normalizeEntryRecord(item));
  const upsertedEntries = normalizedEntries.length ? upsertEntriesByInvoiceNumber(store, normalizedEntries) : [];
  if (ocrJob) {
    store.ocrJobs.push(ocrJob);
  }
  writeStore(store);
  return { document: normalizedDocument, entries: upsertedEntries, ocrJob };
}

function resolveStoredFileAbsolutePath(storedFilePath = '') {
  if (!storedFilePath || !storedFilePath.startsWith('/uploads/')) {
    return '';
  }
  const fileName = path.basename(storedFilePath);
  if (!fileName) return '';
  return path.join(UPLOAD_DIR, fileName);
}

function deleteEntriesByIds(entryIds = []) {
  const normalizedIds = (entryIds || []).map((item) => `${item || ''}`.trim()).filter(Boolean);
  const idSet = new Set(normalizedIds);

  if (!idSet.size) {
    return {
      requestedCount: 0,
      deletedEntryCount: 0,
      deletedDocumentCount: 0,
      deletedJobCount: 0,
      deletedFileCount: 0,
    };
  }

  const store = readStore();
  const selectedEntries = store.entries.filter((item) => idSet.has(item.id));
  const impactedDocumentIds = new Set(selectedEntries.map((item) => item.documentId).filter(Boolean));

  const remainingEntries = store.entries.filter((item) => !idSet.has(item.id));
  const referencedDocumentIds = new Set(remainingEntries.map((item) => item.documentId).filter(Boolean));

  const orphanImpactedDocumentIds = new Set(
    [...impactedDocumentIds].filter((documentId) => !referencedDocumentIds.has(documentId)),
  );

  const documentsToDelete = store.documents.filter((item) => orphanImpactedDocumentIds.has(item.id));
  const filesToDelete = [...new Set(
    documentsToDelete
      .map((item) => resolveStoredFileAbsolutePath(item.storedFilePath))
      .filter(Boolean),
  )];

  const deletedEntryCount = store.entries.length - remainingEntries.length;
  const remainingDocuments = store.documents.filter((item) => !orphanImpactedDocumentIds.has(item.id));
  const deletedDocumentCount = store.documents.length - remainingDocuments.length;
  const remainingJobs = store.ocrJobs.filter((item) => !orphanImpactedDocumentIds.has(item.documentId));
  const deletedJobCount = store.ocrJobs.length - remainingJobs.length;

  let deletedFileCount = 0;
  for (const filePath of filesToDelete) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedFileCount += 1;
      }
    } catch {
      // keep data deletion successful even if one file cleanup fails
    }
  }

  store.entries = remainingEntries;
  store.documents = remainingDocuments;
  store.ocrJobs = remainingJobs;
  writeStore(store);

  return {
    requestedCount: idSet.size,
    deletedEntryCount,
    deletedDocumentCount,
    deletedJobCount,
    deletedFileCount,
  };
}

function sanitizeEntryPatch(patch = {}) {
  const safePatch = {};
  for (const field of ENTRY_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) {
      continue;
    }

    const raw = patch[field];

    if (ENTRY_BOOLEAN_FIELDS.has(field)) {
      safePatch[field] = normalizeSelfPaid(raw, true);
      continue;
    }

    if (ENTRY_NUMERIC_FIELDS.has(field)) {
      if (raw === '' || raw === null || raw === undefined) {
        safePatch[field] = null;
      } else {
        const parsed = Number(raw);
        safePatch[field] = Number.isFinite(parsed) ? parsed : null;
      }
      continue;
    }

    if (ENTRY_DATE_FIELDS.has(field)) {
      safePatch[field] = `${raw || ''}`.trim();
      continue;
    }

    if (ENTRY_DATETIME_FIELDS.has(field)) {
      const candidate = `${raw || ''}`.trim();
      safePatch[field] = dayjs(candidate).isValid() ? dayjs(candidate).toISOString() : '';
      continue;
    }

    safePatch[field] = normalizeText(raw);
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'invoiceNumber')) {
    safePatch.invoiceNumber = normalizeInvoiceNumber(safePatch.invoiceNumber);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'routeTo')) {
    safePatch.routeTo = normalizeText(safePatch.routeTo);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'occurredRegion')) {
    safePatch.occurredRegion = normalizeText(safePatch.occurredRegion);
  }
  return safePatch;
}

function updateEntryById(entryId, patch = {}) {
  const normalizedId = `${entryId || ''}`.trim();
  if (!normalizedId) return null;

  const store = readStore();
  let targetIndex = store.entries.findIndex((item) => item.id === normalizedId);
  if (targetIndex < 0) {
    return null;
  }

  const existing = store.entries[targetIndex];
  const safePatch = sanitizeEntryPatch(patch);
  const merged = normalizeEntryRecord({
    ...existing,
    ...safePatch,
  });
  store.entries[targetIndex] = merged;

  const invoiceNumber = normalizeInvoiceNumber(merged.invoiceNumber);
  let removedDuplicateCount = 0;
  if (invoiceNumber) {
    for (let index = store.entries.length - 1; index >= 0; index -= 1) {
      if (index === targetIndex) continue;
      if (normalizeInvoiceNumber(store.entries[index].invoiceNumber) !== invoiceNumber) continue;
      store.entries.splice(index, 1);
      removedDuplicateCount += 1;
      if (index < targetIndex) {
        targetIndex -= 1;
      }
    }
    store.entries[targetIndex].invoiceNumber = invoiceNumber;
  }

  writeStore(store);
  return {
    item: store.entries[targetIndex],
    removedDuplicateCount,
  };
}

function createManualNonSelfPaidEntry(payload = {}) {
  const occurredDate = normalizeText(payload.occurredDate);
  const expenseCategory = normalizeText(payload.expenseCategory);
  const itemName = normalizeText(payload.itemName);
  const parsedAmount = Number(payload.amount);
  const amount = Number.isFinite(parsedAmount) ? Number(parsedAmount.toFixed(2)) : null;

  if (!occurredDate || !expenseCategory || !itemName || amount === null) {
    return null;
  }

  const createdAt = new Date().toISOString();
  const entry = normalizeEntryRecord({
    id: crypto.randomUUID(),
    documentId: '',
    sourceIndex: 0,
    entryType: 'INVOICE_MANUAL',
    expenseCategory,
    expenseSubCategory: '手工录入',
    invoiceType: '手工票据',
    title: itemName,
    occurredDate,
    invoiceDate: occurredDate,
    createdAt,
    amount,
    amountExcludingTax: null,
    taxAmount: null,
    currency: 'CNY',
    merchantName: '',
    sellerName: '',
    sellerTaxNumber: '',
    purchaserName: '',
    purchaserTaxNumber: '',
    invoiceCode: '',
    invoiceNumber: '',
    selfPaid: false,
    occurredRegion: normalizeText(payload.occurredRegion),
    checkCode: '',
    machineCode: '',
    routeFrom: '',
    routeTo: '',
    travelerName: '',
    seatClass: '',
    itemName,
    specification: '',
    unit: '',
    quantity: null,
    unitPrice: null,
    rawFields: {
      manual: true,
      createdBy: 'MANUAL_DIALOG',
    },
  });

  const store = readStore();
  store.entries.push(entry);
  writeStore(store);
  return entry;
}

function updateEntriesRegion(entryIds = [], region = '') {
  const normalizedIds = (entryIds || []).map((item) => normalizeText(item)).filter(Boolean);
  const idSet = new Set(normalizedIds);
  const normalizedRegion = normalizeText(region);

  if (!idSet.size || !normalizedRegion) {
    return {
      requestedCount: idSet.size,
      updatedCount: 0,
      region: normalizedRegion,
    };
  }

  const store = readStore();
  let updatedCount = 0;
  store.entries = store.entries.map((entry) => {
    if (!idSet.has(entry.id)) return entry;
    updatedCount += 1;
    return normalizeEntryRecord({
      ...entry,
      occurredRegion: normalizedRegion,
    });
  });

  if (updatedCount > 0) {
    writeStore(store);
  }

  return {
    requestedCount: idSet.size,
    updatedCount,
    region: normalizedRegion,
  };
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
  const documentMap = new Map(store.documents.map((item) => [item.id, item]));
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
  const items = filtered.slice(startIndex, startIndex + safePageSize).map((item) => {
    const document = documentMap.get(item.documentId);
    return {
      ...item,
      sourceFilePath: document?.storedFilePath || '',
      sourceFileName: document?.originalName || '',
    };
  });
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
  createManualNonSelfPaidEntry,
  deleteEntriesByIds,
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
  updateEntriesRegion,
  updateEntryById,
  upsertDocument,
  writeStore,
};
