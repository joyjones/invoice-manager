import fs from 'node:fs';
import OCRApi from '@alicloud/ocr-api20210707';
import OpenApi from '@alicloud/openapi-client';
import TeaUtil from '@alicloud/tea-util';
import { createLogger, normalizeError } from './logger.js';

let cachedClient = null;

function getOcrClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  const endpoint = process.env.ALIYUN_OCR_ENDPOINT || 'ocr-api.cn-hangzhou.aliyuncs.com';
  const regionId = process.env.ALIYUN_REGION_ID || 'cn-hangzhou';

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('阿里云 OCR 凭据缺失，请设置 ALIYUN_ACCESS_KEY_ID 与 ALIYUN_ACCESS_KEY_SECRET');
  }

  const config = new OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    endpoint,
    regionId,
  });

  cachedClient = new OCRApi.default(config);
  return cachedClient;
}

function parseData(data) {
  if (!data) return {};
  if (typeof data === 'object') return data;
  if (typeof data !== 'string') return {};
  try {
    return JSON.parse(data);
  } catch {
    return { rawText: data };
  }
}

function hasUsefulData(body) {
  const value = body?.data;
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return false;
}

function getProviderCode(response) {
  return `${response?.body?.code ?? ''}`.trim();
}

function isSuccessResponse(response) {
  const statusCode = Number(response?.statusCode || 0);
  const code = getProviderCode(response).toUpperCase();
  if (code) {
    return code === '200' || code === 'OK';
  }
  return statusCode === 200 && hasUsefulData(response?.body);
}

function readResponseMessage(response) {
  return response?.body?.message || '';
}

function getRuntimeOptions() {
  const connectTimeout = Number(process.env.OCR_CONNECT_TIMEOUT_MS || 10000);
  const readTimeout = Number(process.env.OCR_READ_TIMEOUT_MS || 20000);
  const maxAttempts = Number(process.env.OCR_MAX_ATTEMPTS || 2);
  return new TeaUtil.RuntimeOptions({
    connectTimeout,
    readTimeout,
    autoretry: maxAttempts > 1,
    maxAttempts,
  });
}

function isRetryableMessage(message = '') {
  return /timeout|timed out|connecttimeout|readtimeout|socket hang up|econnreset|econnrefused/i.test(
    message,
  );
}

function responseToAction(name, response, elapsedMs) {
  return {
    name,
    statusCode: Number(response?.statusCode || 0),
    providerCode: getProviderCode(response),
    requestId: response?.body?.requestId || '',
    message: readResponseMessage(response),
    hasData: hasUsefulData(response?.body),
    elapsedMs,
  };
}

async function runAction({ name, execute, log }) {
  const startedAt = Date.now();
  const retries = Math.max(1, Number(process.env.OCR_ACTION_RETRIES || 2));

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await execute();
      const action = responseToAction(name, response, Date.now() - startedAt);
      action.attempt = attempt;
      log.info(`${name} 响应`, action);
      return {
        ok: isSuccessResponse(response),
        action,
        response,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`;
      const retryable = isRetryableMessage(message);
      lastError = error;
      log.warn(`${name} 调用异常`, {
        attempt,
        retries,
        retryable,
        error: normalizeError(error),
      });
      if (!retryable || attempt >= retries) {
        break;
      }
    }
  }

  return {
    ok: false,
    action: {
      name,
      statusCode: 0,
      providerCode: '',
      requestId: '',
      message: lastError instanceof Error ? lastError.message : `${lastError || ''}`,
      hasData: false,
      elapsedMs: Date.now() - startedAt,
      error: normalizeError(lastError),
      attempt: retries,
    },
    response: null,
    error: lastError,
  };
}

async function recognizeDocumentFromFile(filePath, context = {}) {
  const log = createLogger('ocr', context);
  const client = getOcrClient();

  log.info('开始 OCR 识别', { filePath });
  const actions = [];

  const mixed = await runAction({
    name: 'RecognizeMixedInvoices',
    execute: () => {
      const request = new OCRApi.RecognizeMixedInvoicesRequest({
        body: fs.createReadStream(filePath),
        mergePdfPages: true,
      });
      return client.recognizeMixedInvoicesWithOptions(request, getRuntimeOptions());
    },
    log,
  });
  actions.push(mixed.action);
  if (mixed.ok) {
    return {
      success: true,
      usedAction: mixed.action.name,
      providerRequestId: mixed.action.requestId,
      providerCode: mixed.action.providerCode,
      providerMessage: mixed.action.message,
      raw: parseData(mixed.response?.body?.data),
      actions,
    };
  }

  const invoice = await runAction({
    name: 'RecognizeInvoice',
    execute: () => {
      const request = new OCRApi.RecognizeInvoiceRequest({
        body: fs.createReadStream(filePath),
      });
      return client.recognizeInvoiceWithOptions(request, getRuntimeOptions());
    },
    log,
  });
  actions.push(invoice.action);
  if (invoice.ok) {
    return {
      success: true,
      usedAction: invoice.action.name,
      providerRequestId: invoice.action.requestId,
      providerCode: invoice.action.providerCode,
      providerMessage: invoice.action.message,
      raw: parseData(invoice.response?.body?.data),
      actions,
    };
  }

  const allText = await runAction({
    name: 'RecognizeAllText',
    execute: () => {
      const request = new OCRApi.RecognizeAllTextRequest({
        type: 'Advanced',
        body: fs.createReadStream(filePath),
      });
      return client.recognizeAllTextWithOptions(request, getRuntimeOptions());
    },
    log,
  });
  actions.push(allText.action);
  if (allText.ok) {
    return {
      success: true,
      usedAction: allText.action.name,
      providerRequestId: allText.action.requestId,
      providerCode: allText.action.providerCode,
      providerMessage: allText.action.message,
      raw: parseData(allText.response?.body?.data),
      actions,
    };
  }

  const lastAction = actions[actions.length - 1] || null;
  const message =
    lastAction?.message || 'OCR 识别失败：发票识别与全文识别均未获得有效结果';

  log.error('OCR 全部识别策略失败', {
    message,
    actions,
  });

  return {
    success: false,
    usedAction: '',
    providerRequestId: lastAction?.requestId || '',
    providerCode: lastAction?.providerCode || '',
    providerMessage: message,
    raw: {},
    actions,
    errorMessage: message,
  };
}

export { parseData, recognizeDocumentFromFile };
