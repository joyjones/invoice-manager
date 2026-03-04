import crypto from 'node:crypto';
import dayjs from 'dayjs';

function parseJSONMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstNonEmpty(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return `${value}`.trim();
    }
  }
  return '';
}

function normalizeDate(value) {
  if (!value) return '';
  const raw = `${value}`.trim();
  const candidates = [
    raw,
    raw.replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, ''),
    raw.replace(/\./g, '-'),
  ];

  for (const candidate of candidates) {
    const parsed = dayjs(candidate);
    if (parsed.isValid()) {
      return parsed.format('YYYY-MM-DD');
    }
  }
  return '';
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = `${value}`.replace(/[￥,\s]/g, '');
  const match = raw.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0]);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

function isPlausibleAmount(value) {
  return value !== null && value <= 100000 && value >= -100000;
}

function pickNumberFromKeys(source, keys) {
  for (const key of keys) {
    const parsed = normalizeNumber(source?.[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function extractLastDecimal(value) {
  if (value === null || value === undefined) return null;
  const raw = `${value}`.replace(/[￥,\s]/g, '');
  const matches = raw.match(/-?\d+\.\d{1,2}/g);
  if (!matches || matches.length === 0) return null;
  const parsed = Number.parseFloat(matches[matches.length - 1]);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parseStrictNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = `${value}`.replace(/[￥,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function extractAmountFromText(text) {
  if (!text) return null;
  const source = `${text}`;
  const patterns = [
    /CNY\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /价税合计[:：]?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /含税金额[:：]?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /金额[:：]?\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...source.matchAll(pattern)];
    if (matches.length > 0) {
      const value = Number.parseFloat(matches[matches.length - 1][1]);
      if (Number.isFinite(value)) {
        const normalized = Number(value.toFixed(2));
        if (isPlausibleAmount(normalized)) {
          return normalized;
        }
      }
    }
  }
  return null;
}

function extractDetailAmount(detail) {
  let amount = pickNumberFromKeys(detail, ['amount', 'price', 'totalAmount', 'fare', 'actualFare', 'totalFee']);
  if (isPlausibleAmount(amount)) {
    return amount;
  }

  // Some transit itinerary PDFs put fare into tax/taxRate-like fields when OCR fails on layout.
  amount = pickNumberFromKeys(detail, ['tax']);
  if (isPlausibleAmount(amount)) {
    return amount;
  }

  amount = extractLastDecimal(firstNonEmpty(detail, ['taxRate', 'remark', 'description']));
  if (isPlausibleAmount(amount)) {
    return amount;
  }

  amount = extractAmountFromText(firstNonEmpty(detail, ['itemName', 'name', 'remark', 'description']));
  if (isPlausibleAmount(amount)) {
    return amount;
  }

  const quantity = parseStrictNumber(firstNonEmpty(detail, ['quantity', 'count']));
  const unitPrice = parseStrictNumber(firstNonEmpty(detail, ['unitPrice', 'price']));
  if (quantity !== null && unitPrice !== null) {
    const calculated = Number((quantity * unitPrice).toFixed(2));
    if (quantity > 0 && quantity <= 20 && isPlausibleAmount(calculated)) {
      return calculated;
    }
  }

  return null;
}

function parseArrayMaybe(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const parsed = parseJSONMaybe(value);
  return Array.isArray(parsed) ? parsed : [];
}

function pickFirstNonEmptyArray(values) {
  for (const value of values) {
    const parsed = parseArrayMaybe(value);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

function flattenTextFromPayload(payload) {
  if (!payload) return '';
  const parsed = parseJSONMaybe(payload) ?? payload;
  if (typeof parsed === 'string') return parsed;
  const content = firstNonEmpty(parsed, ['content', 'text', 'rawText']);
  if (content) return content;
  if (Array.isArray(parsed?.subMsgs)) {
    return parsed.subMsgs
      .map((item) => flattenTextFromPayload(item?.result || item))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function pickDataRoot(raw) {
  if (!raw) return {};

  const parsed = parseJSONMaybe(raw) ?? raw;

  if (Array.isArray(parsed?.subMsgs) && parsed.subMsgs.length > 0) {
    const list = parsed.subMsgs
      .map((item) => item?.result || item)
      .map((item) => parseJSONMaybe(item) ?? item)
      .filter(Boolean);
    if (list.length) {
      return pickDataRoot(list[0]);
    }
  }

  if (parsed?.result) {
    return pickDataRoot(parsed.result);
  }

  const nestedData = parseJSONMaybe(parsed?.data) ?? parsed?.data;

  if (Array.isArray(nestedData) && nestedData.length > 0) {
    return pickDataRoot(nestedData[0]);
  }

  if (nestedData?.data) {
    return pickDataRoot(nestedData.data);
  }

  if (Array.isArray(nestedData?.invoices) && nestedData.invoices.length > 0) {
    return pickDataRoot(nestedData.invoices[0]);
  }

  if (Array.isArray(nestedData?.subImages) && nestedData.subImages.length > 0) {
    return pickDataRoot(nestedData.subImages[0]);
  }

  return nestedData ?? parsed ?? {};
}

function extractCandidates(rawPayload) {
  const parsed = parseJSONMaybe(rawPayload) ?? rawPayload;
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  if (Array.isArray(parsed.subMsgs) && parsed.subMsgs.length > 0) {
    return parsed.subMsgs.map((msg, index) => {
      const result = parseJSONMaybe(msg?.result) ?? msg?.result ?? msg;
      const root = pickDataRoot(result);
      return {
        sourceIndex: index,
        sourceType: firstNonEmpty(msg || {}, ['type', 'op']) || firstNonEmpty(result || {}, ['type']),
        root,
        raw: result,
      };
    });
  }

  return [
    {
      sourceIndex: 0,
      sourceType: firstNonEmpty(parsed || {}, ['type']) || '',
      root: pickDataRoot(parsed),
      raw: parsed,
    },
  ];
}

function inferExpenseCategory(text) {
  const source = text || '';
  if (/酒店|住宿|宾馆|旅馆/.test(source)) return '住宿';
  if (/餐饮|餐费|饭店|酒楼/.test(source)) return '餐饮';
  if (/高铁|火车|动车|铁路|12306/.test(source)) return '交通-火车';
  if (/机票|航空|航班|民航/.test(source)) return '交通-机票';
  if (/地铁|公交|巴士/.test(source)) return '交通-地铁公交';
  if (/出租|打车|滴滴|网约车|的士/.test(source)) return '交通-打车';
  if (/停车|过路|通行费|路桥/.test(source)) return '交通-过路停车';
  if (/地铁出行|trip|行程/.test(source)) return '交通-地铁公交';
  if (/购物|超市|商店/.test(source)) return '购物';
  if (/培训|会务|课程/.test(source)) return '培训会务';
  return '其他';
}

function inferDocSubType(text, sourceType = '') {
  const source = `${text || ''} ${sourceType || ''}`;
  if (/行程报销单|汇总|出差|培训|itinerary|summary/i.test(source)) return 'TRAVEL_SUMMARY';
  if (/电子普通发票|增值税/.test(source)) return 'VAT_INVOICE';
  if (/专用发票/.test(source)) return 'VAT_SPECIAL_INVOICE';
  if (/火车|高铁|动车|铁路/.test(source)) return 'TRAIN_TICKET';
  if (/机票|航班|航空/.test(source)) return 'FLIGHT_TICKET';
  if (/出租|网约车|滴滴|的士/.test(source)) return 'TAXI_TICKET';
  if (/地铁|公交/.test(source)) return 'PUBLIC_TRANSPORT_TICKET';
  if (/trip|地铁出行|行程报销单/i.test(source)) return 'PUBLIC_TRANSPORT_TICKET';
  if (/酒店|住宿/.test(source)) return 'HOTEL_RECEIPT';
  return 'UNKNOWN';
}

function collectCommonFields(root) {
  const detailsCandidate = pickFirstNonEmptyArray([
    root?.invoiceDetails,
    root?.detailList,
    root?.items,
    root?.rideDetails,
  ]);
  const title = firstNonEmpty(root, [
    'title',
    'invoiceType',
    'invoiceKind',
    'invoiceName',
    'formType',
    'type',
    'name',
  ]);

  const invoiceDate = normalizeDate(
    firstNonEmpty(root, ['invoiceDate', 'date', 'billingDate', 'tradeDate', 'issueDate', 'applicationDate']),
  );

  let amount = pickNumberFromKeys(root, [
    'totalAmount',
    'invoiceAmount',
    'amount',
    'fare',
    'actualFare',
    'sumAmount',
    'totalFee',
  ]);
  if (!isPlausibleAmount(amount)) {
    const detailSum = detailsCandidate.reduce((sum, item) => sum + (extractDetailAmount(item) || 0), 0);
    amount = isPlausibleAmount(Number(detailSum.toFixed(2))) ? Number(detailSum.toFixed(2)) : null;
  }

  const amountExcludingTax = pickNumberFromKeys(root, ['invoiceAmountPreTax', 'amountWithoutTax', 'preTaxAmount']);

  const taxAmount = pickNumberFromKeys(root, ['invoiceTax', 'tax', 'taxAmount']);

  const common = {
    title,
    invoiceType: firstNonEmpty(root, ['invoiceType', 'title', 'invoiceKind', 'type']) || '未识别类型',
    invoiceDate,
    amount,
    amountExcludingTax,
    taxAmount,
    currency: firstNonEmpty(root, ['currency']) || 'CNY',
    invoiceCode: firstNonEmpty(root, ['invoiceCode', 'code', 'ticketCode']),
    invoiceNumber: firstNonEmpty(root, ['invoiceNumber', 'invoiceNo', 'number', 'serialNumber', 'ticketNo']),
    checkCode: firstNonEmpty(root, ['checkCode', 'verifyCode']),
    machineCode: firstNonEmpty(root, ['machineCode']),
    sellerName: firstNonEmpty(root, ['sellerName', 'sellName', 'merchantName', 'serviceProvider']),
    sellerTaxNumber: firstNonEmpty(root, ['sellerTaxNumber', 'sellerCode', 'sellerTaxNo']),
    purchaserName: firstNonEmpty(root, ['purchaserName', 'buyerName']),
    purchaserTaxNumber: firstNonEmpty(root, ['purchaserTaxNumber', 'buyerTaxNo']),
    routeFrom: firstNonEmpty(root, ['fromStation', 'departureStation', 'startStation', 'from', 'startPlace']),
    routeTo: firstNonEmpty(root, ['toStation', 'arrivalStation', 'endStation', 'to', 'endPlace']),
    travelerName: firstNonEmpty(root, ['passengerName', 'travelerName', 'name']),
    transportNo: firstNonEmpty(root, ['trainNumber', 'flightNo', 'vehicleNo', 'busNo', 'transportNo', 'carType']),
    seatClass: firstNonEmpty(root, ['seatClass', 'seatNo', 'seatType']),
  };

  const expenseHint = [
    common.title,
    common.invoiceType,
    common.sellerName,
    common.routeFrom,
    common.routeTo,
  ]
    .filter(Boolean)
    .join(' ');

  common.expenseCategory = inferExpenseCategory(expenseHint);
  common.docSubType = inferDocSubType(expenseHint);
  return common;
}

function isInvoiceLike(common, root, sourceType = '') {
  if (common.invoiceCode || common.invoiceNumber) return true;
  if (common.amount !== null) return true;
  const keys = Object.keys(root || {});
  if (keys.some((key) => /invoice|tax|票|车次|金额/i.test(key))) return true;
  const text = `${common.title || ''} ${common.invoiceType || ''} ${sourceType || ''}`;
  return /发票|车票|行程单|票据|税/.test(text);
}

function buildEntriesFromCommon({ common, root, documentId, sourceIndex, createdAt }) {
  const details = pickFirstNonEmptyArray([
    root?.invoiceDetails,
    root?.detailList,
    root?.items,
    root?.rideDetails,
  ]);

  const base = {
    documentId,
    sourceIndex,
    invoiceType: common.invoiceType,
    title: common.title,
    occurredDate: common.invoiceDate,
    invoiceDate: common.invoiceDate,
    createdAt,
    expenseCategory: common.expenseCategory,
    expenseSubCategory: common.docSubType,
    currency: common.currency || 'CNY',
    merchantName: common.sellerName,
    sellerName: common.sellerName,
    sellerTaxNumber: common.sellerTaxNumber,
    purchaserName: common.purchaserName,
    purchaserTaxNumber: common.purchaserTaxNumber,
    invoiceCode: common.invoiceCode,
    invoiceNumber: common.invoiceNumber,
    checkCode: common.checkCode,
    machineCode: common.machineCode,
    routeFrom: common.routeFrom,
    routeTo: common.routeTo,
    travelerName: common.travelerName,
    transportNo: common.transportNo,
    seatClass: common.seatClass,
  };

  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail, index) => {
      const amount = extractDetailAmount(detail);
      const quantity = normalizeNumber(firstNonEmpty(detail, ['quantity', 'count']));
      const unitPrice = normalizeNumber(firstNonEmpty(detail, ['unitPrice', 'price']));

      return {
        id: crypto.randomUUID(),
        ...base,
        entryType: 'INVOICE_LINE',
        amount: amount ?? common.amount ?? 0,
        amountExcludingTax: common.amountExcludingTax,
        taxAmount: common.taxAmount,
        itemName:
          firstNonEmpty(detail, ['itemName', 'name']) ||
          (firstNonEmpty(detail, ['Number']) ? `行程${firstNonEmpty(detail, ['Number'])}` : common.title),
        specification: firstNonEmpty(detail, ['specification', 'spec']),
        unit: firstNonEmpty(detail, ['unit']),
        quantity,
        unitPrice,
        rawFields: {
          detailIndex: index,
          detail,
          common,
          root,
        },
      };
    });
  }

  return [
    {
      id: crypto.randomUUID(),
      ...base,
      entryType: 'INVOICE_TOTAL',
      amount: common.amount ?? 0,
      amountExcludingTax: common.amountExcludingTax,
      taxAmount: common.taxAmount,
      itemName: common.title,
      specification: '',
      unit: '',
      quantity: null,
      unitPrice: null,
      rawFields: {
        common,
        root,
      },
    },
  ];
}

function cleanEntries(entries) {
  return (entries || []).filter((entry) => {
    const amount = Number(entry.amount);
    const hasPositiveAmount = Number.isFinite(amount) && amount > 0;
    const hasTextIdentity = [entry.itemName, entry.title, entry.invoiceNumber, entry.invoiceCode]
      .some((value) => `${value || ''}`.trim() !== '');

    if (hasPositiveAmount) {
      return true;
    }

    if (entry.entryType === 'INVOICE_TOTAL') {
      return hasTextIdentity;
    }

    return hasTextIdentity && `${entry.itemName || ''}`.trim() !== '';
  });
}

function normalizeRecognizedDocument({
  documentId,
  fileName,
  ext,
  createdAt,
  rawPayload,
  plainText = '',
}) {
  const candidates = extractCandidates(rawPayload);
  const entries = [];
  const commonList = [];

  for (const candidate of candidates) {
    const common = collectCommonFields(candidate.root || {});
    commonList.push(common);
    if (isInvoiceLike(common, candidate.root, candidate.sourceType)) {
      entries.push(
        ...buildEntriesFromCommon({
          common,
          root: candidate.root,
          documentId,
          sourceIndex: candidate.sourceIndex,
          createdAt,
        }),
      );
    }
  }
  const normalizedEntries = cleanEntries(entries);

  const firstCommon = commonList.find((item) => item.invoiceType !== '未识别类型') || commonList[0] || {
    title: '',
    invoiceType: '未识别类型',
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
    docSubType: 'UNKNOWN',
  };

  const filenameHint = fileName || '';
  const sourceTypeHint = candidates.map((candidate) => candidate.sourceType).filter(Boolean).join(' ');
  const textHint = `${filenameHint} ${plainText} ${flattenTextFromPayload(rawPayload)} ${firstCommon.title || ''} ${sourceTypeHint}`;
  const hasSummaryHint = /行程报销单|汇总|出差|培训|itinerary|summary/i.test(textHint) || ext === '.docx';
  const hasInvoiceSignals =
    normalizedEntries.length > 0 ||
    commonList.some(
      (item) =>
        item.invoiceCode ||
        item.invoiceNumber ||
        item.invoiceType !== '未识别类型' ||
        item.docSubType !== 'UNKNOWN' ||
        isPlausibleAmount(item.amount),
    );

  let docCategory = 'OTHER';
  if (hasSummaryHint) {
    docCategory = 'SUMMARY';
  } else if (hasInvoiceSignals) {
    docCategory = 'INVOICE';
  }

  const docSubType = inferDocSubType(textHint, firstCommon.docSubType);
  const tags = [firstCommon.expenseCategory, docSubType, docCategory].filter(Boolean);

  return {
    docCategory,
    docSubType,
    title: firstCommon.title || fileName,
    tags: [...new Set(tags)],
    commonFields: {
      invoiceType: firstCommon.invoiceType,
      invoiceDate: firstCommon.invoiceDate,
      amount: firstCommon.amount,
      amountExcludingTax: firstCommon.amountExcludingTax,
      taxAmount: firstCommon.taxAmount,
      currency: firstCommon.currency,
      invoiceCode: firstCommon.invoiceCode,
      invoiceNumber: firstCommon.invoiceNumber,
      checkCode: firstCommon.checkCode,
      machineCode: firstCommon.machineCode,
      sellerName: firstCommon.sellerName,
      sellerTaxNumber: firstCommon.sellerTaxNumber,
      purchaserName: firstCommon.purchaserName,
      purchaserTaxNumber: firstCommon.purchaserTaxNumber,
      routeFrom: firstCommon.routeFrom,
      routeTo: firstCommon.routeTo,
      travelerName: firstCommon.travelerName,
      transportNo: firstCommon.transportNo,
      seatClass: firstCommon.seatClass,
      expenseCategory: firstCommon.expenseCategory,
    },
    entries: normalizedEntries,
    extraFields: {
      plainText,
      candidates: candidates.map((candidate) => ({
        sourceIndex: candidate.sourceIndex,
        sourceType: candidate.sourceType,
        root: candidate.root,
      })),
      rawPayload: parseJSONMaybe(rawPayload) ?? rawPayload,
    },
  };
}

function normalizeDocxSummary({
  documentId,
  fileName,
  createdAt,
  plainText = '',
}) {
  const expenseCategory = inferExpenseCategory(`${fileName} ${plainText}`);
  const docSubType = inferDocSubType(`${fileName} ${plainText}`);

  return {
    docCategory: 'SUMMARY',
    docSubType,
    title: fileName,
    tags: ['SUMMARY', expenseCategory, docSubType],
    commonFields: {
      invoiceType: '汇总文档',
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
      expenseCategory,
    },
    entries: [],
    extraFields: {
      plainText,
      rawPayload: {},
    },
  };
}

export {
  extractCandidates,
  normalizeDocxSummary,
  normalizeRecognizedDocument,
  parseJSONMaybe,
};
