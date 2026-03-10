import fs from 'node:fs';
import OCRApi from '@alicloud/ocr-api20210707';
import OpenApi from '@alicloud/openapi-client';
import TeaUtil from '@alicloud/tea-util';
import { createLogger, normalizeError } from './logger.js';

let cachedClient = null;
const OCR_MAX_SAFE_ATTEMPTS = 3;
const OCR_MAX_SAFE_ACTION_RETRIES = 3;

function toBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function readBooleanEnv(name, fallback) {
  const value = `${process.env[name] || ''}`.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

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

function getRuntimeConfig() {
  const connectTimeout = toBoundedInteger(process.env.OCR_CONNECT_TIMEOUT_MS, 10000, 1000, 120000);
  const readTimeout = toBoundedInteger(process.env.OCR_READ_TIMEOUT_MS, 20000, 1000, 180000);
  const maxAttempts = toBoundedInteger(
    process.env.OCR_MAX_ATTEMPTS,
    1,
    1,
    OCR_MAX_SAFE_ATTEMPTS,
  );
  return {
    connectTimeout,
    readTimeout,
    maxAttempts,
    options: new TeaUtil.RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: maxAttempts > 1,
      maxAttempts,
    }),
  };
}

function getActionRetries() {
  return toBoundedInteger(process.env.OCR_ACTION_RETRIES, 1, 1, OCR_MAX_SAFE_ACTION_RETRIES);
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

async function runAction({ name, execute, log, retries }) {
  const startedAt = Date.now();
  const attempts = Math.max(1, retries);

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
        retries: attempts,
        retryable,
        error: normalizeError(error),
      });
      if (!retryable || attempt >= attempts) {
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
      attempt: attempts,
    },
    response: null,
    error: lastError,
  };
}

async function recognizeDocumentFromFile(filePath, context = {}) {
  const log = createLogger('ocr', context);
  const client = getOcrClient();
  const runtimeConfig = getRuntimeConfig();
  const actionRetries = getActionRetries();
  const enableInvoiceFallback = readBooleanEnv('OCR_ENABLE_INVOICE_FALLBACK', true);
  const enableAllTextFallback = readBooleanEnv('OCR_ENABLE_ALL_TEXT_FALLBACK', false);

  log.info('开始 OCR 识别', { filePath });
  log.info('OCR 策略配置', {
    actionRetries,
    runtimeMaxAttempts: runtimeConfig.maxAttempts,
    connectTimeout: runtimeConfig.connectTimeout,
    readTimeout: runtimeConfig.readTimeout,
    enableInvoiceFallback,
    enableAllTextFallback,
  });
  const actions = [];

  const mixed = await runAction({
    name: 'RecognizeMixedInvoices',
    retries: actionRetries,
    execute: () => {
      const request = new OCRApi.RecognizeMixedInvoicesRequest({
        body: fs.createReadStream(filePath),
        mergePdfPages: true,
      });
      return client.recognizeMixedInvoicesWithOptions(request, runtimeConfig.options);
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

  if (enableInvoiceFallback) {
    const invoice = await runAction({
      name: 'RecognizeInvoice',
      retries: actionRetries,
      execute: () => {
        const request = new OCRApi.RecognizeInvoiceRequest({
          body: fs.createReadStream(filePath),
        });
        return client.recognizeInvoiceWithOptions(request, runtimeConfig.options);
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
  } else {
    log.warn('RecognizeInvoice 兜底已关闭');
  }

  if (enableAllTextFallback) {
    const allText = await runAction({
      name: 'RecognizeAllText',
      retries: actionRetries,
      execute: () => {
        const request = new OCRApi.RecognizeAllTextRequest({
          type: 'Advanced',
          body: fs.createReadStream(filePath),
        });
        return client.recognizeAllTextWithOptions(request, runtimeConfig.options);
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
  } else {
    log.warn('RecognizeAllText 兜底已关闭');
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
