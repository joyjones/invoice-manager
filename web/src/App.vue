
<script setup>
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'
import {
  createManualEntry,
  deleteEntries,
  exportSummaryReport,
  fetchEntries,
  fetchExpenseCategories,
  fetchInvoiceTypes,
  fetchOcrJobs,
  updateEntriesRegion,
  updateEntry,
  uploadDocuments,
} from './api'

const now = dayjs()
const activeTab = ref('entries')
const files = ref([])
const isUploading = ref(false)
const isExporting = ref(false)
const isLoading = ref(false)
const isDeletingEntries = ref(false)
const isSavingEntry = ref(false)
const isSavingManual = ref(false)
const isSavingRegion = ref(false)
const message = ref('')
const messageType = ref('success')
const errorMessage = ref('')

const invoiceTypes = ref([])
const expenseCategories = ref([])

const entryFilters = ref({
  dateField: 'UPLOAD_DATE',
  startDate: now.startOf('month').format('YYYY-MM-DD'),
  endDate: now.endOf('month').format('YYYY-MM-DD'),
  type: 'ALL',
  expenseCategory: 'ALL',
  keyword: '',
})

const jobFilters = ref({ status: 'ALL', keyword: '' })
const entries = ref([])
const entriesTotal = ref(0)
const entriesAmount = ref(0)
const entryPage = ref(1)
const entryPageSize = ref(20)
const selectedEntryIds = ref([])

const jobs = ref([])
const jobsTotal = ref(0)
const jobPage = ref(1)
const jobPageSize = ref(20)

const entrySort = ref({ key: '', order: '' })
const jobSort = ref({ key: '', order: '' })

const isEditDialogOpen = ref(false)
const editingEntryId = ref('')
const editForm = ref({})

const isManualDialogOpen = ref(false)
const manualForm = ref({ occurredDate: dayjs().format('YYYY-MM-DD'), expenseCategory: '', amount: '', itemName: '' })

const isRegionDialogOpen = ref(false)
const regionForm = ref({ region: '' })

const entryTotalPages = computed(() => Math.max(1, Math.ceil(entriesTotal.value / entryPageSize.value)))
const jobTotalPages = computed(() => Math.max(1, Math.ceil(jobsTotal.value / jobPageSize.value)))
const allEntriesSelected = computed(() => entries.value.length > 0 && selectedEntryIds.value.length === entries.value.length)
const canEditSelected = computed(() => selectedEntryIds.value.length === 1)
const canDeleteSelected = computed(() => selectedEntryIds.value.length > 0)
const canBatchEditRegion = computed(() => selectedEntryIds.value.length > 0)
const messageClass = computed(() => (messageType.value === 'error' ? 'error-message' : 'ok-message'))

const invoiceExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp'])
const uploadBatchSize = 50
const selectedSource = ref('')
const selectedDirectoryName = ref('')

const editFieldDefs = [
  { key: 'createdAt', label: '上传时间', type: 'datetime-local' },
  { key: 'occurredDate', label: '发生日期', type: 'date' },
  { key: 'occurredRegion', label: '发生地区', type: 'text' },
  { key: 'selfPaid', label: '自费', type: 'checkbox' },
  { key: 'invoiceDate', label: '发票日期', type: 'date' },
  { key: 'invoiceType', label: '票据类型', type: 'text' },
  { key: 'expenseCategory', label: '费用分类', type: 'text' },
  { key: 'expenseSubCategory', label: '子分类', type: 'text' },
  { key: 'amount', label: '金额', type: 'number', step: '0.01' },
  { key: 'amountExcludingTax', label: '未税金额', type: 'number', step: '0.01' },
  { key: 'taxAmount', label: '税额', type: 'number', step: '0.01' },
  { key: 'currency', label: '币种', type: 'text' },
  { key: 'invoiceNumber', label: '发票号码', type: 'text' },
  { key: 'sellerName', label: '销售方', type: 'text' },
  { key: 'sellerTaxNumber', label: '销售方税号', type: 'text' },
  { key: 'purchaserName', label: '购买方', type: 'text' },
  { key: 'purchaserTaxNumber', label: '购买方税号', type: 'text' },
  { key: 'merchantName', label: '商户', type: 'text' },
  { key: 'routeFrom', label: '出发地', type: 'text' },
  { key: 'routeTo', label: '目的地/线路补充', type: 'text' },
  { key: 'travelerName', label: '乘车人', type: 'text' },
  { key: 'seatClass', label: '座位等级', type: 'text' },
  { key: 'itemName', label: '明细项', type: 'text' },
  { key: 'specification', label: '规格', type: 'text' },
  { key: 'unit', label: '单位', type: 'text' },
  { key: 'quantity', label: '数量', type: 'number', step: '0.01' },
  { key: 'unitPrice', label: '单价', type: 'number', step: '0.01' },
  { key: 'title', label: '标题', type: 'text' },
  { key: 'entryType', label: '条目类型', type: 'text' },
  { key: 'sourceIndex', label: '来源索引', type: 'number', step: '1' },
  { key: 'checkCode', label: '校验码', type: 'text' },
  { key: 'machineCode', label: '机器编码', type: 'text' },
]

const numericEditFields = new Set(editFieldDefs.filter((item) => item.type === 'number').map((item) => item.key))
const dateEditFields = new Set(editFieldDefs.filter((item) => item.type === 'date').map((item) => item.key))
const dateTimeEditFields = new Set(editFieldDefs.filter((item) => item.type === 'datetime-local').map((item) => item.key))
const booleanEditFields = new Set(editFieldDefs.filter((item) => item.type === 'checkbox').map((item) => item.key))

function getFileExtension(fileName = '') {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : ''
}

function splitUploadableFiles(fileList = []) {
  const uploadable = []
  const unsupported = []
  for (const file of fileList) {
    const ext = getFileExtension(file?.name || '')
    if (invoiceExtensions.has(ext)) uploadable.push(file)
    else unsupported.push(file)
  }
  return { uploadable, unsupported }
}

const uploadSelection = computed(() => splitUploadableFiles(files.value))
const selectedUploadSummary = computed(() => {
  if (!files.value.length) return ''
  if (selectedSource.value === 'directory') {
    const dir = selectedDirectoryName.value || '-'
    return `已选择目录：${dir}（共 ${files.value.length} 个文件，可导入票据 ${uploadSelection.value.uploadable.length} 个）`
  }
  return `已选择 ${files.value.length} 个文件（可导入票据 ${uploadSelection.value.uploadable.length} 个）`
})
const selectedUploadFiles = computed(() => files.value.slice(0, 8).map((file) => file.webkitRelativePath || file.name))
const hasMoreSelectedFiles = computed(() => files.value.length > 8)

function getDirectoryName(fileList = []) {
  const first = fileList.find((item) => item?.webkitRelativePath)
  if (!first) return ''
  return `${first.webkitRelativePath}`.split('/')[0] || ''
}

function clearUploadInputs() {
  const fileInput = document.getElementById('invoice-files')
  const directoryInput = document.getElementById('invoice-directory')
  if (fileInput) fileInput.value = ''
  if (directoryInput) directoryInput.value = ''
}

function onSelectFiles(event) {
  files.value = Array.from(event.target.files || [])
  selectedSource.value = files.value.length ? 'files' : ''
  selectedDirectoryName.value = ''
  const directoryInput = document.getElementById('invoice-directory')
  if (directoryInput) directoryInput.value = ''
}

function onSelectDirectory(event) {
  const selectedFiles = Array.from(event.target.files || [])
  files.value = selectedFiles
  selectedSource.value = selectedFiles.length ? 'directory' : ''
  selectedDirectoryName.value = getDirectoryName(selectedFiles)
  const fileInput = document.getElementById('invoice-files')
  if (fileInput) fileInput.value = ''
}
function normalizeSortValue(value) {
  if (value === null || value === undefined) return ''
  return value
}

function compareSortValues(a, b) {
  const va = normalizeSortValue(a)
  const vb = normalizeSortValue(b)

  const na = Number(va)
  const nb = Number(vb)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb

  const da = dayjs(va)
  const db = dayjs(vb)
  if (da.isValid() && db.isValid()) return da.valueOf() - db.valueOf()

  return `${va}`.localeCompare(`${vb}`, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

function applySort(list, sortState, valueGetters) {
  if (!sortState.key || !sortState.order) return list
  const getter = valueGetters[sortState.key]
  if (typeof getter !== 'function') return list

  return [...list].sort((left, right) => {
    const result = compareSortValues(getter(left), getter(right))
    return sortState.order === 'asc' ? result : -result
  })
}

function getSortRef(scope) {
  return scope === 'jobs' ? jobSort : entrySort
}

function cycleSort(scope, key) {
  const sortRef = getSortRef(scope)
  const state = sortRef.value
  if (state.key !== key) {
    sortRef.value = { key, order: 'asc' }
    return
  }
  if (state.order === 'asc') {
    sortRef.value = { key, order: 'desc' }
    return
  }
  sortRef.value = { key: '', order: '' }
}

function sortMark(scope, key) {
  const state = getSortRef(scope).value
  if (state.key !== key || !state.order) return '↕'
  return state.order === 'asc' ? '↑' : '↓'
}

function formatRoute(item) {
  return [item.routeFrom, item.routeTo].filter(Boolean).join(' -> ') || '-'
}

const sortedEntries = computed(() => applySort(entries.value, entrySort.value, {
  createdAt: (item) => item.createdAt,
  occurredDate: (item) => item.occurredDate,
  occurredRegion: (item) => item.occurredRegion,
  selfPaid: (item) => (item.selfPaid ? 1 : 0),
  invoiceType: (item) => item.invoiceType,
  expenseCategory: (item) => item.expenseCategory,
  amount: (item) => item.amount,
  sellerName: (item) => item.sellerName,
  invoiceNo: (item) => `${item.invoiceNumber || ''} ${item.invoiceCode || ''}`,
  route: (item) => formatRoute(item),
  itemName: (item) => item.itemName,
  sourceFileName: (item) => item.sourceFileName,
}))

const sortedJobs = computed(() => applySort(jobs.value, jobSort.value, {
  startedAt: (item) => item.startedAt,
  status: (item) => item.status,
  source: (item) => item.source,
  traceId: (item) => item.traceId,
  elapsedMs: (item) => item.elapsedMs,
  errorMessage: (item) => item.errorMessage,
}))

function formatDateTime(value) {
  if (!value) return '-'
  return dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : value
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2)
}

function formatStatus(value) {
  const map = { SUCCESS: '成功', PARTIAL: '部分成功', FAILED: '失败', SKIPPED: '跳过' }
  return map[value] || value || '-'
}

function formatSelfPaid(value) {
  return value ? '是' : '否'
}

function formatInvoiceNo(item) {
  const invoiceNumber = `${item?.invoiceNumber || ''}`.trim()
  const invoiceCode = `${item?.invoiceCode || ''}`.trim()
  if (invoiceNumber && invoiceCode) return `${invoiceNumber}（代码:${invoiceCode}）`
  return invoiceNumber || invoiceCode || '-'
}

function resolveApiError(err, fallbackMessage) {
  const backendMessage = err?.response?.data?.message
  if (backendMessage) return backendMessage
  const status = err?.response?.status
  if (status === 404) return '接口返回 404。请确认后端服务已启动，并从 http://localhost:5173 访问前端。'
  if (status >= 500) return '后端服务异常，请检查 server 日志。'
  if (err?.code === 'ERR_NETWORK') return '无法连接后端服务，请确认 http://localhost:3001 已启动。'
  return err?.message || fallbackMessage
}

function toDateInputValue(value) {
  if (!value) return ''
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : ''
}

function toDateTimeLocalValue(value) {
  if (!value) return ''
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('YYYY-MM-DDTHH:mm') : ''
}

function normalizeEditFieldValue(field, rawValue) {
  if (booleanEditFields.has(field.key)) return Boolean(rawValue)
  if (dateEditFields.has(field.key)) return toDateInputValue(rawValue)
  if (dateTimeEditFields.has(field.key)) return toDateTimeLocalValue(rawValue)
  if (numericEditFields.has(field.key)) return rawValue === null || rawValue === undefined || rawValue === '' ? '' : `${rawValue}`
  return `${rawValue ?? ''}`
}

function buildEditPayload() {
  const payload = {}
  for (const field of editFieldDefs) {
    const raw = editForm.value[field.key]
    if (booleanEditFields.has(field.key)) {
      payload[field.key] = Boolean(raw)
      continue
    }
    if (numericEditFields.has(field.key)) {
      payload[field.key] = raw === '' || raw === null || raw === undefined ? null : Number(raw)
      if (!Number.isFinite(payload[field.key])) payload[field.key] = null
      continue
    }
    if (dateEditFields.has(field.key)) {
      payload[field.key] = `${raw || ''}`.trim()
      continue
    }
    if (dateTimeEditFields.has(field.key)) {
      const candidate = `${raw || ''}`.trim()
      payload[field.key] = dayjs(candidate).isValid() ? dayjs(candidate).toISOString() : ''
      continue
    }
    payload[field.key] = `${raw ?? ''}`.trim()
  }
  return payload
}

function findSelectedEntry() {
  if (selectedEntryIds.value.length !== 1) return null
  return entries.value.find((item) => item.id === selectedEntryIds.value[0]) || null
}

function openEditSelectedEntry() {
  const target = findSelectedEntry()
  if (!target) return

  const next = {}
  for (const field of editFieldDefs) next[field.key] = normalizeEditFieldValue(field, target[field.key])

  editForm.value = next
  editingEntryId.value = target.id
  isEditDialogOpen.value = true
}

function closeEditDialog(force = false) {
  if (!force && isSavingEntry.value) return
  isEditDialogOpen.value = false
  editingEntryId.value = ''
  editForm.value = {}
}

async function saveEditedEntry() {
  if (!editingEntryId.value) return

  isSavingEntry.value = true
  errorMessage.value = ''
  try {
    const result = await updateEntry(editingEntryId.value, buildEditPayload())
    messageType.value = 'success'
    message.value = result?.message || '编辑成功'
    closeEditDialog(true)
    await refreshAll()
  } catch (err) {
    const trace = err?.response?.data?.traceId ? ` traceId=${err.response.data.traceId}` : ''
    errorMessage.value = `${resolveApiError(err, '编辑失败')}${trace}`
  } finally {
    isSavingEntry.value = false
  }
}

function openManualDialog() {
  manualForm.value = { occurredDate: dayjs().format('YYYY-MM-DD'), expenseCategory: '', amount: '', itemName: '' }
  isManualDialogOpen.value = true
}

function closeManualDialog(force = false) {
  if (!force && isSavingManual.value) return
  isManualDialogOpen.value = false
}

function openRegionDialog() {
  if (!selectedEntryIds.value.length) return
  regionForm.value = { region: '' }
  isRegionDialogOpen.value = true
}

function closeRegionDialog(force = false) {
  if (!force && isSavingRegion.value) return
  isRegionDialogOpen.value = false
}
async function saveManualEntry() {
  const payload = {
    occurredDate: `${manualForm.value.occurredDate || ''}`.trim(),
    expenseCategory: `${manualForm.value.expenseCategory || ''}`.trim(),
    amount: Number(manualForm.value.amount),
    itemName: `${manualForm.value.itemName || ''}`.trim(),
  }
  if (!payload.occurredDate || !payload.expenseCategory || !payload.itemName || !Number.isFinite(payload.amount)) {
    errorMessage.value = '请完整填写发生日期、分类、金额、明细项'
    return
  }

  isSavingManual.value = true
  errorMessage.value = ''
  try {
    const result = await createManualEntry(payload)
    messageType.value = 'success'
    message.value = result?.message || '新增非自费项成功'
    closeManualDialog(true)
    await refreshAll()
  } catch (err) {
    const trace = err?.response?.data?.traceId ? ` traceId=${err.response.data.traceId}` : ''
    errorMessage.value = `${resolveApiError(err, '新增非自费项失败')}${trace}`
  } finally {
    isSavingManual.value = false
  }
}

async function saveRegionBatch() {
  const region = `${regionForm.value.region || ''}`.trim()
  if (!region) {
    errorMessage.value = '发生地区不能为空'
    return
  }

  isSavingRegion.value = true
  errorMessage.value = ''
  try {
    const result = await updateEntriesRegion(selectedEntryIds.value, region)
    messageType.value = 'success'
    message.value = result?.message || `地区更新完成：共更新 ${selectedEntryIds.value.length} 条`
    closeRegionDialog(true)
    await refreshAll()
  } catch (err) {
    const trace = err?.response?.data?.traceId ? ` traceId=${err.response.data.traceId}` : ''
    errorMessage.value = `${resolveApiError(err, '更新地区失败')}${trace}`
  } finally {
    isSavingRegion.value = false
  }
}

async function refreshMetaOptions() {
  const [types, categories] = await Promise.all([fetchInvoiceTypes(), fetchExpenseCategories()])
  invoiceTypes.value = types
  expenseCategories.value = categories
}

async function refreshEntries() {
  const data = await fetchEntries({ ...entryFilters.value, page: entryPage.value, pageSize: entryPageSize.value })
  entries.value = data.items || []
  entriesTotal.value = data.total || 0
  entriesAmount.value = data.totalAmount || 0
  selectedEntryIds.value = []
}

async function refreshJobs() {
  const data = await fetchOcrJobs({ ...jobFilters.value, page: jobPage.value, pageSize: jobPageSize.value })
  jobs.value = data.items || []
  jobsTotal.value = data.total || 0
}

async function refreshAll() {
  isLoading.value = true
  errorMessage.value = ''
  try {
    await Promise.all([refreshMetaOptions(), refreshEntries(), refreshJobs()])
  } catch (err) {
    errorMessage.value = resolveApiError(err, '刷新数据失败')
  } finally {
    isLoading.value = false
  }
}

async function submitUpload() {
  if (!files.value.length) {
    errorMessage.value = '请先选择文件或目录'
    return
  }
  const { uploadable, unsupported } = uploadSelection.value
  if (!uploadable.length) {
    errorMessage.value = '所选内容都不是票据格式，仅支持 PDF/JPG/JPEG/PNG/WEBP/BMP'
    return
  }

  isUploading.value = true
  errorMessage.value = ''
  message.value = ''

  try {
    const result = await uploadDocuments(uploadable, {
      batchSize: uploadBatchSize,
      onProgress(progress) {
        if (progress.totalBatches > 1) {
          messageType.value = 'success'
          message.value = `正在导入：第 ${progress.completedBatches}/${progress.totalBatches} 批（${progress.uploadedFiles}/${progress.totalFiles}）`
        }
      },
    })

    const selectedCount = files.value.length
    const successCount = Number(result?.successCount || 0)
    const importedCount = Number(result?.documentCount || 0)
    const entryCount = Number(result?.entryCount || 0)
    const ignoredCount = Number(result?.ignoredCount || 0)
    const failedCount = Number(result?.failedCount ?? result?.failCount ?? 0)
    const unsupportedCount = unsupported.length

    let summary = `处理完成：共选择 ${selectedCount} 个文件，成功导入 ${successCount} 个票据（文档 ${importedCount} 条，票据条目 ${entryCount} 条）`
    if (ignoredCount > 0) summary += `，忽略非票据 ${ignoredCount} 个`
    if (unsupportedCount > 0) summary += `，跳过非票据格式 ${unsupportedCount} 个`
    if (failedCount > 0) summary += `，失败 ${failedCount} 个`

    messageType.value = failedCount > 0 ? 'error' : 'success'
    message.value = summary

    files.value = []
    selectedSource.value = ''
    selectedDirectoryName.value = ''
    clearUploadInputs()
    await refreshAll()
  } catch (err) {
    const trace = err?.response?.data?.traceId ? ` traceId=${err.response.data.traceId}` : ''
    errorMessage.value = `${resolveApiError(err, '上传失败')}${trace}`
  } finally {
    isUploading.value = false
  }
}

function isEntrySelected(entryId) {
  return selectedEntryIds.value.includes(entryId)
}

function toggleEntrySelection(entryId, checked) {
  if (!entryId) return
  if (checked) {
    if (!selectedEntryIds.value.includes(entryId)) selectedEntryIds.value = [...selectedEntryIds.value, entryId]
    return
  }
  selectedEntryIds.value = selectedEntryIds.value.filter((id) => id !== entryId)
}

function toggleSelectAllEntries(checked) {
  selectedEntryIds.value = checked ? entries.value.map((item) => item.id).filter(Boolean) : []
}

async function deleteSelectedEntries() {
  if (!selectedEntryIds.value.length) return
  if (!window.confirm(`确认删除选中的 ${selectedEntryIds.value.length} 条记录吗？`)) return

  isDeletingEntries.value = true
  errorMessage.value = ''
  message.value = ''
  try {
    const result = await deleteEntries(selectedEntryIds.value)
    messageType.value = 'success'
    message.value = result?.message || `删除完成（${selectedEntryIds.value.length} 条）`
    selectedEntryIds.value = []
    await refreshAll()
  } catch (err) {
    const trace = err?.response?.data?.traceId ? ` traceId=${err.response.data.traceId}` : ''
    errorMessage.value = `${resolveApiError(err, '删除失败')}${trace}`
  } finally {
    isDeletingEntries.value = false
  }
}

async function doSearchEntries() {
  entryPage.value = 1
  await refreshEntries()
}

async function doSearchJobs() {
  jobPage.value = 1
  await refreshJobs()
}

async function doExportSummary() {
  isExporting.value = true
  errorMessage.value = ''
  try {
    const blob = await exportSummaryReport({ ...entryFilters.value })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `票据报表-${entryFilters.value.startDate}-到-${entryFilters.value.endDate}.xlsx`
    link.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    errorMessage.value = resolveApiError(err, '生成报表失败')
  } finally {
    isExporting.value = false
  }
}

async function changeEntryPage(nextPage) {
  entryPage.value = Math.min(Math.max(1, nextPage), entryTotalPages.value)
  await refreshEntries()
}

async function changeJobPage(nextPage) {
  jobPage.value = Math.min(Math.max(1, nextPage), jobTotalPages.value)
  await refreshJobs()
}

onMounted(async () => {
  await refreshAll()
})
</script>

<template>
  <div class="page">
    <header class="hero">
      <h1>差旅票据管理器（静姐专用版）</h1>
      <p>你的差旅票据管家</p>
    </header>

    <section class="panel upload-panel">
      <h2>上传票据</h2>
      <div class="upload-row">
        <label class="picker-button">选择文件
          <input id="invoice-files" class="hidden-file-input" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.bmp" @change="onSelectFiles" />
        </label>
        <label class="picker-button">选择目录
          <input id="invoice-directory" class="hidden-file-input" type="file" webkitdirectory directory multiple @change="onSelectDirectory" />
        </label>
      </div>
      <div class="upload-actions-row">
        <button :disabled="isUploading || !files.length" @click="submitUpload">{{ isUploading ? '处理中...' : (selectedSource === 'directory' ? '导入目录' : '上传票据') }}</button>
      </div>
      <div v-if="files.length" class="selected-files-box">
        <p class="selected-files-title">{{ selectedUploadSummary }}</p>
        <ul class="selected-files-list"><li v-for="name in selectedUploadFiles" :key="name">{{ name }}</li></ul>
        <p v-if="hasMoreSelectedFiles" class="muted">还有 {{ files.length - 8 }} 个文件未展开显示</p>
      </div>
      <p class="muted">目录导入会自动跳过非票据格式文件；上传后识别为非票据会忽略，不写入票据清单。</p>
      <p v-if="message" :class="messageClass">{{ message }}</p>
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
    </section>

    <section class="tab-block">
      <div class="tab-strip">
        <button :class="activeTab === 'entries' ? 'tab-btn active' : 'tab-btn'" @click="activeTab = 'entries'">票据清单</button>
        <button :class="activeTab === 'jobs' ? 'tab-btn active' : 'tab-btn'" @click="activeTab = 'jobs'">上传记录</button>
      </div>

      <section v-if="activeTab === 'entries'" class="panel tab-panel">
        <div class="filters-grid">
          <label>日期维度<select v-model="entryFilters.dateField"><option value="UPLOAD_DATE">上传时间</option><option value="INVOICE_DATE">发票日期</option></select></label>
          <label>开始日期 <input v-model="entryFilters.startDate" type="date" /></label>
          <label>结束日期 <input v-model="entryFilters.endDate" type="date" /></label>
          <label>发票类型<select v-model="entryFilters.type"><option value="ALL">全部</option><option v-for="item in invoiceTypes" :key="item" :value="item">{{ item }}</option></select></label>
          <label>费用分类<select v-model="entryFilters.expenseCategory"><option value="ALL">全部</option><option v-for="item in expenseCategories" :key="item" :value="item">{{ item }}</option></select></label>
          <label class="keyword">关键字 <input v-model.trim="entryFilters.keyword" type="text" placeholder="发票号/商家/路线/明细" /></label>
        </div>
        <div class="actions-row">
          <button @click="doSearchEntries">查询</button>
          <button :disabled="isExporting" @click="doExportSummary">{{ isExporting ? '生成中...' : '生成报表' }}</button>
          <button class="ghost" @click="openManualDialog">添加非自费项</button>
          <button class="ghost" :disabled="!canBatchEditRegion || isSavingRegion" @click="openRegionDialog">编辑地区</button>
          <button class="ghost" :disabled="!canEditSelected || isSavingEntry" @click="openEditSelectedEntry">编辑选中</button>
          <button class="danger" :disabled="isDeletingEntries || !canDeleteSelected" @click="deleteSelectedEntries">{{ isDeletingEntries ? '删除中...' : `删除选中(${selectedEntryIds.length})` }}</button>
        </div>
        <p class="summary">票据数: {{ entriesTotal }}，金额合计: {{ formatMoney(entriesAmount) }} 元</p>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="checkbox-col"><input type="checkbox" :checked="allEntriesSelected" @change="toggleSelectAllEntries($event.target.checked)" /></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'createdAt')">上传时间 {{ sortMark('entries', 'createdAt') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'occurredDate')">发生日期 {{ sortMark('entries', 'occurredDate') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'occurredRegion')">发生地区 {{ sortMark('entries', 'occurredRegion') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'selfPaid')">自费 {{ sortMark('entries', 'selfPaid') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'invoiceType')">类型 {{ sortMark('entries', 'invoiceType') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'expenseCategory')">分类 {{ sortMark('entries', 'expenseCategory') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'amount')">金额 {{ sortMark('entries', 'amount') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'sellerName')">销售方 {{ sortMark('entries', 'sellerName') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'invoiceNo')">发票号码 {{ sortMark('entries', 'invoiceNo') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'route')">线路 {{ sortMark('entries', 'route') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'itemName')">明细 {{ sortMark('entries', 'itemName') }}</button></th>
                <th><button class="table-sort-btn" @click="cycleSort('entries', 'sourceFileName')">原始文件 {{ sortMark('entries', 'sourceFileName') }}</button></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!sortedEntries.length"><td colspan="13" class="empty">暂无条目</td></tr>
              <tr v-for="item in sortedEntries" :key="item.id">
                <td class="checkbox-col"><input type="checkbox" :checked="isEntrySelected(item.id)" @change="toggleEntrySelection(item.id, $event.target.checked)" /></td>
                <td>{{ formatDateTime(item.createdAt) }}</td>
                <td>{{ item.occurredDate || '-' }}</td>
                <td>{{ item.occurredRegion || '-' }}</td>
                <td>{{ formatSelfPaid(item.selfPaid) }}</td>
                <td>{{ item.invoiceType || '-' }}</td>
                <td>{{ item.expenseCategory || '-' }}</td>
                <td>{{ formatMoney(item.amount) }}</td>
                <td>{{ item.sellerName || '-' }}</td>
                <td>{{ formatInvoiceNo(item) }}</td>
                <td>{{ formatRoute(item) }}</td>
                <td>{{ item.itemName || '-' }}</td>
                <td><a v-if="item.sourceFilePath" :href="item.sourceFilePath" target="_blank" rel="noreferrer">查看原件</a><span v-else>-</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager"><button :disabled="entryPage <= 1" @click="changeEntryPage(entryPage - 1)">上一页</button><span>第 {{ entryPage }} / {{ entryTotalPages }} 页</span><button :disabled="entryPage >= entryTotalPages" @click="changeEntryPage(entryPage + 1)">下一页</button></div>
      </section>

      <section v-if="activeTab === 'jobs'" class="panel tab-panel">
        <div class="filters-grid two-col">
          <label>状态<select v-model="jobFilters.status"><option value="ALL">全部</option><option value="SUCCESS">成功</option><option value="PARTIAL">部分成功</option><option value="FAILED">失败</option><option value="SKIPPED">跳过</option></select></label>
          <label class="keyword">关键字 <input v-model.trim="jobFilters.keyword" type="text" placeholder="traceId/requestId/错误信息" /></label>
        </div>
        <div class="actions-row"><button @click="doSearchJobs">查询</button></div>
        <p class="summary">记录数: {{ jobsTotal }}</p>
        <div class="table-wrap"><table><thead><tr>
          <th><button class="table-sort-btn" @click="cycleSort('jobs', 'startedAt')">上传时间 {{ sortMark('jobs', 'startedAt') }}</button></th>
          <th><button class="table-sort-btn" @click="cycleSort('jobs', 'status')">状态 {{ sortMark('jobs', 'status') }}</button></th>
          <th><button class="table-sort-btn" @click="cycleSort('jobs', 'source')">来源 {{ sortMark('jobs', 'source') }}</button></th>
          <th><button class="table-sort-btn" @click="cycleSort('jobs', 'traceId')">追踪ID {{ sortMark('jobs', 'traceId') }}</button></th>
          <th><button class="table-sort-btn" @click="cycleSort('jobs', 'elapsedMs')">耗时（毫秒） {{ sortMark('jobs', 'elapsedMs') }}</button></th>
          <th>动作链路</th>
          <th><button class="table-sort-btn" @click="cycleSort('jobs', 'errorMessage')">错误 {{ sortMark('jobs', 'errorMessage') }}</button></th>
        </tr></thead><tbody>
          <tr v-if="!sortedJobs.length"><td colspan="7" class="empty">暂无记录</td></tr>
          <tr v-for="job in sortedJobs" :key="job.id">
            <td>{{ formatDateTime(job.startedAt) }}</td><td>{{ formatStatus(job.status) }}</td><td>{{ job.source }}</td><td>{{ job.traceId || '-' }}</td><td>{{ job.elapsedMs }}</td>
            <td>{{ (job.actions || []).map(action => `${action.name}:${action.statusCode || '-'}:${action.requestId || '-'}`).join(' | ') || '-' }}</td><td>{{ job.errorMessage || '-' }}</td>
          </tr>
        </tbody></table></div>
        <div class="pager"><button :disabled="jobPage <= 1" @click="changeJobPage(jobPage - 1)">上一页</button><span>第 {{ jobPage }} / {{ jobTotalPages }} 页</span><button :disabled="jobPage >= jobTotalPages" @click="changeJobPage(jobPage + 1)">下一页</button></div>
      </section>
    </section>
    <div v-if="isEditDialogOpen" class="modal-mask" @click.self="closeEditDialog()">
      <div class="modal-card">
        <h3>编辑选中票据</h3>
        <div class="modal-fields">
          <label v-for="field in editFieldDefs" :key="field.key" class="modal-field" :class="field.type === 'checkbox' ? 'checkbox-field' : ''">
            <span>{{ field.label }}</span>
            <input v-if="field.type !== 'checkbox'" v-model="editForm[field.key]" :type="field.type" :step="field.step || undefined" :placeholder="field.label" />
            <input v-else v-model="editForm[field.key]" type="checkbox" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="ghost" :disabled="isSavingEntry" @click="closeEditDialog()">取消</button>
          <button :disabled="isSavingEntry" @click="saveEditedEntry">{{ isSavingEntry ? '保存中...' : '确定' }}</button>
        </div>
      </div>
    </div>

    <div v-if="isManualDialogOpen" class="modal-mask" @click.self="closeManualDialog">
      <div class="modal-card simple-modal">
        <h3>添加非自费项</h3>
        <div class="modal-fields">
          <label class="modal-field"><span>发生日期</span><input v-model="manualForm.occurredDate" type="date" /></label>
          <label class="modal-field"><span>分类</span><input v-model.trim="manualForm.expenseCategory" type="text" placeholder="例如：交通-打车" /></label>
          <label class="modal-field"><span>金额</span><input v-model="manualForm.amount" type="number" step="0.01" placeholder="0.00" /></label>
          <label class="modal-field"><span>明细项</span><input v-model.trim="manualForm.itemName" type="text" placeholder="填写票据明细" /></label>
        </div>
        <div class="modal-actions">
          <button class="ghost" :disabled="isSavingManual" @click="closeManualDialog">取消</button>
          <button :disabled="isSavingManual" @click="saveManualEntry">{{ isSavingManual ? '保存中...' : '确定' }}</button>
        </div>
      </div>
    </div>

    <div v-if="isRegionDialogOpen" class="modal-mask" @click.self="closeRegionDialog">
      <div class="modal-card simple-modal">
        <h3>编辑地区</h3>
        <div class="modal-fields">
          <label class="modal-field"><span>发生地区</span><input v-model.trim="regionForm.region" type="text" placeholder="例如：北京市" /></label>
        </div>
        <div class="modal-actions">
          <button class="ghost" :disabled="isSavingRegion" @click="closeRegionDialog">取消</button>
          <button :disabled="isSavingRegion" @click="saveRegionBatch">{{ isSavingRegion ? '保存中...' : '确定' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
