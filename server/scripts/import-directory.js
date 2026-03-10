import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { logger } from '../lib/logger.js';
import { collectFilesRecursively, importFileFromPath } from '../lib/processor.js';
import { addProcessResult, ensureDataStore, getStoreStats, resetBusinessData } from '../lib/storage.js';

dotenv.config();
ensureDataStore();

const allowBulkImport = `${process.env.ALLOW_BULK_OCR_IMPORT || ''}`.trim().toLowerCase() === 'true';
if (!allowBulkImport) {
  console.error(
    '已阻止目录全量 OCR 导入。请先设置 ALLOW_BULK_OCR_IMPORT=true 后再执行，避免误触发高额费用。',
  );
  process.exit(1);
}

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('缺少目录参数。示例: npm run import:dir -- /absolute/path/to/invoices');
  process.exit(1);
}

const rootDir = path.resolve(targetDir);

if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
  console.error(`目录不存在或不可读: ${rootDir}`);
  process.exit(1);
}

logger.info('开始全量导入目录', { rootDir });
logger.info('清空旧业务数据（文档/条目/识别记录）');
resetBusinessData();

const files = collectFilesRecursively(rootDir);
logger.info('扫描到文件', { totalFiles: files.length });

const counters = {
  total: files.length,
  success: 0,
  partial: 0,
  failed: 0,
  skipped: 0,
  invoiceDocs: 0,
  summaryDocs: 0,
  otherDocs: 0,
  entryCount: 0,
};

for (let i = 0; i < files.length; i += 1) {
  const absolutePath = files[i];
  const rel = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
  logger.info('处理文件', { index: i + 1, total: files.length, file: rel });

  const result = await importFileFromPath({
    absolutePath,
    sourceRoot: rootDir,
  });

  addProcessResult(result);

  const status = result.document.processingStatus;
  if (status === 'SUCCESS') counters.success += 1;
  else if (status === 'PARTIAL') counters.partial += 1;
  else if (status === 'FAILED') counters.failed += 1;
  else counters.skipped += 1;

  if (result.document.docCategory === 'INVOICE') counters.invoiceDocs += 1;
  else if (result.document.docCategory === 'SUMMARY') counters.summaryDocs += 1;
  else counters.otherDocs += 1;

  counters.entryCount += result.entries.length;
}

const stats = getStoreStats();
logger.info('目录导入完成', {
  counters,
  storeStats: stats,
});

console.log('\n=== IMPORT SUMMARY ===');
console.log(`目录: ${rootDir}`);
console.log(`总文件: ${counters.total}`);
console.log(`处理成功: ${counters.success}`);
console.log(`部分成功: ${counters.partial}`);
console.log(`处理失败: ${counters.failed}`);
console.log(`跳过: ${counters.skipped}`);
console.log(`发票文档: ${counters.invoiceDocs}`);
console.log(`汇总文档: ${counters.summaryDocs}`);
console.log(`其他文档: ${counters.otherDocs}`);
console.log(`抽取条目数: ${counters.entryCount}`);
console.log(`存储统计: documents=${stats.documents}, entries=${stats.entries}, ocrJobs=${stats.ocrJobs}`);
