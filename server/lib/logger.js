import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const LOG_DIR = path.join(ROOT_DIR, 'data', 'logs');

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLOR = {
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET_COLOR = '\x1b[0m';
function getLogLevel() {
  return `${process.env.LOG_LEVEL || 'info'}`.toLowerCase();
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function normalizeError(error) {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: error };
}

function trimLongString(value, maxLength = 800) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...(truncated ${value.length - maxLength} chars)`;
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }
  const copy = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.toLowerCase().includes('secret') || key.toLowerCase().includes('password')) {
      copy[key] = '***';
      continue;
    }
    if (value instanceof Error) {
      copy[key] = normalizeError(value);
      continue;
    }
    copy[key] = typeof value === 'string' ? trimLongString(value) : value;
  }
  return copy;
}

function getLogFilePath() {
  const day = dayjs().format('YYYY-MM-DD');
  return path.join(LOG_DIR, `server-${day}.log`);
}

function writeLine(line) {
  ensureLogDir();
  fs.appendFileSync(getLogFilePath(), `${line}\n`, 'utf-8');
}

function shouldLog(level) {
  const weight = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
  const activeWeight = LEVEL_WEIGHT[getLogLevel()] ?? LEVEL_WEIGHT.info;
  return weight >= activeWeight;
}

function buildConsoleLine(level, scope, message, context, meta) {
  const time = dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');
  const color = LEVEL_COLOR[level] || '';
  const lvl = `${level}`.toUpperCase().padEnd(5, ' ');
  const trace = context.traceId ? ` [trace:${context.traceId}]` : '';
  const base = `${color}${time} ${lvl}${RESET_COLOR} [${scope}]${trace} ${message}`;
  if (!meta || Object.keys(meta).length === 0) {
    return base;
  }
  return `${base} ${JSON.stringify(meta)}`;
}

function buildJsonLine(level, scope, message, context, meta) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...context,
    meta,
  });
}

function emitLog(level, scope, message, context = {}, meta = {}) {
  if (!shouldLog(level)) {
    return;
  }
  const safeContext = safeMeta(context) || {};
  const normalizedMeta = safeMeta(meta) || {};
  const consoleLine = buildConsoleLine(level, scope, message, safeContext, normalizedMeta);
  const jsonLine = buildJsonLine(level, scope, message, safeContext, normalizedMeta);

  if (level === 'error') {
    console.error(consoleLine);
  } else if (level === 'warn') {
    console.warn(consoleLine);
  } else {
    console.log(consoleLine);
  }
  writeLine(jsonLine);
}

function createLogger(scope, context = {}) {
  return {
    debug(message, meta = {}) {
      emitLog('debug', scope, message, context, meta);
    },
    info(message, meta = {}) {
      emitLog('info', scope, message, context, meta);
    },
    warn(message, meta = {}) {
      emitLog('warn', scope, message, context, meta);
    },
    error(message, meta = {}) {
      emitLog('error', scope, message, context, meta);
    },
    child(extraContext = {}) {
      return createLogger(scope, { ...context, ...extraContext });
    },
  };
}

const logger = createLogger('server');

export { LOG_DIR, createLogger, logger, normalizeError };
