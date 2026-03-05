import axios from 'axios'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 240000,
})

const DEFAULT_UPLOAD_BATCH_SIZE = 50

function createUploadTaskId() {
  if (typeof globalThis?.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `upload_${Date.now()}_${Math.round(Math.random() * 1e9)}`
}

function toSafeCount(value) {
  const count = Number(value)
  return Number.isFinite(count) ? count : 0
}

function chunkFiles(files, chunkSize) {
  const chunks = []
  for (let i = 0; i < files.length; i += chunkSize) {
    chunks.push(files.slice(i, i + chunkSize))
  }
  return chunks
}

function emitUploadProgress(options, payload) {
  if (typeof options?.onProgress === 'function') {
    options.onProgress(payload)
  }
}

function mergeUploadResult(target, data) {
  target.totalFileCount += toSafeCount(data?.totalFileCount)
  target.successCount += toSafeCount(data?.successCount)
  target.failedCount += toSafeCount(data?.failedCount ?? data?.failCount)
  target.ignoredCount += toSafeCount(data?.ignoredCount)
  target.documentCount += toSafeCount(data?.documentCount)
  target.entryCount += toSafeCount(data?.entryCount)
  target.documents.push(...(data?.documents || []))
  target.ignoredFiles.push(...(data?.ignoredFiles || []))
  target.failedFiles.push(...(data?.failedFiles || []))
  if (data?.traceId) target.traceIds.push(data.traceId)
}

export async function uploadDocuments(files, options = {}) {
  const normalizedFiles = Array.from(files || [])
  const uploadTaskId = `${options.uploadTaskId || createUploadTaskId()}`
  if (!normalizedFiles.length) {
    return {
      message: '请选择至少一个文件',
      traceId: '',
      traceIds: [],
      totalFileCount: 0,
      successCount: 0,
      failedCount: 0,
      failCount: 0,
      ignoredCount: 0,
      documentCount: 0,
      entryCount: 0,
      ignoredFiles: [],
      failedFiles: [],
      documents: [],
      stats: null,
      uploadTaskId,
    }
  }

  const batchSize = Math.max(1, Number(options.batchSize) || DEFAULT_UPLOAD_BATCH_SIZE)
  const batches = chunkFiles(normalizedFiles, batchSize)

  if (batches.length === 1) {
    emitUploadProgress(options, {
      phase: 'processing',
      currentBatch: 1,
      completedBatches: 0,
      totalBatches: 1,
      processedFiles: 0,
      totalFiles: normalizedFiles.length,
      batchFileCount: normalizedFiles.length,
    })

    const formData = new FormData()
    for (const file of normalizedFiles) {
      formData.append('files', file)
    }
    const { data } = await apiClient.post('/documents/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
        'x-upload-task-id': uploadTaskId,
      },
    })
    emitUploadProgress(options, {
      phase: 'completed',
      currentBatch: 1,
      completedBatches: 1,
      totalBatches: 1,
      processedFiles: normalizedFiles.length,
      totalFiles: normalizedFiles.length,
      batchFileCount: normalizedFiles.length,
    })
    return {
      ...data,
      uploadTaskId: data?.uploadTaskId || uploadTaskId,
      totalFileCount: toSafeCount(data?.totalFileCount || normalizedFiles.length),
      successCount: toSafeCount(data?.successCount),
      failedCount: toSafeCount(data?.failedCount ?? data?.failCount),
      failCount: toSafeCount(data?.failedCount ?? data?.failCount),
      ignoredCount: toSafeCount(data?.ignoredCount),
      ignoredFiles: data?.ignoredFiles || [],
      failedFiles: data?.failedFiles || [],
      traceIds: data?.traceId ? [data.traceId] : [],
    }
  }

  const merged = {
    totalFileCount: 0,
    successCount: 0,
    failedCount: 0,
    ignoredCount: 0,
    documentCount: 0,
    entryCount: 0,
    documents: [],
    ignoredFiles: [],
    failedFiles: [],
    stats: null,
    traceIds: [],
  }

  let uploadedFiles = 0
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    emitUploadProgress(options, {
      phase: 'processing',
      currentBatch: index + 1,
      completedBatches: index,
      totalBatches: batches.length,
      processedFiles: uploadedFiles,
      totalFiles: normalizedFiles.length,
      batchFileCount: batch.length,
    })

    const formData = new FormData()
    for (const file of batch) {
      formData.append('files', file)
    }
    const { data } = await apiClient.post('/documents/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
        'x-upload-task-id': uploadTaskId,
      },
    })
    mergeUploadResult(merged, data)
    merged.stats = data?.stats || merged.stats
    uploadedFiles += batch.length

    emitUploadProgress(options, {
      phase: 'completed',
      currentBatch: index + 1,
      completedBatches: index + 1,
      totalBatches: batches.length,
      processedFiles: uploadedFiles,
      totalFiles: normalizedFiles.length,
      batchFileCount: batch.length,
    })
  }

  return {
    message: `处理完成，共 ${normalizedFiles.length} 个文件，成功导入 ${merged.successCount} 个发票`,
    uploadTaskId,
    traceId: merged.traceIds[0] || '',
    totalFileCount: merged.totalFileCount || normalizedFiles.length,
    failCount: merged.failedCount,
    ...merged,
  }
}

export async function fetchUploadProgress(taskId) {
  const { data } = await apiClient.get(`/uploads/progress/${encodeURIComponent(taskId)}`)
  return data
}

export async function fetchEntries(params) {
  const { data } = await apiClient.get('/entries', { params })
  return data
}

export async function deleteEntries(ids) {
  const { data } = await apiClient.delete('/entries', {
    data: { ids: Array.isArray(ids) ? ids : [] },
  })
  return data
}

export async function updateEntry(id, payload) {
  const { data } = await apiClient.put(`/entries/${encodeURIComponent(id)}`, payload || {})
  return data
}

export async function createManualEntry(payload) {
  const { data } = await apiClient.post('/entries/manual', payload || {})
  return data
}

export async function updateEntriesRegion(ids, region) {
  const { data } = await apiClient.put('/entries/region', {
    ids: Array.isArray(ids) ? ids : [],
    region: `${region || ''}`,
  })
  return data
}

export async function fetchOcrJobs(params) {
  const { data } = await apiClient.get('/ocr-jobs', { params })
  return data
}

export async function fetchInvoiceTypes() {
  const { data } = await apiClient.get('/invoices/types')
  return data.items || []
}

export async function fetchExpenseCategories() {
  const { data } = await apiClient.get('/expenses/categories')
  return data.items || []
}

export async function exportEntries(params) {
  const response = await apiClient.get('/invoices/export', {
    params,
    responseType: 'blob',
  })
  return response.data
}

export async function exportSummaryReport(params) {
  const response = await apiClient.get('/invoices/export-summary', {
    params,
    responseType: 'blob',
  })
  return response.data
}
