<script setup>
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'
import {
  exportEntries,
  fetchDocuments,
  fetchEntries,
  fetchExpenseCategories,
  fetchInvoiceTypes,
  fetchOcrJobs,
  uploadDocuments,
} from './api'

const now = dayjs()
const activeTab = ref('entries')
const files = ref([])
const isUploading = ref(false)
const isExporting = ref(false)
const isLoading = ref(false)
const message = ref('')
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

const docFilters = ref({
  dateField: 'UPLOAD_DATE',
  startDate: now.startOf('month').format('YYYY-MM-DD'),
  endDate: now.endOf('month').format('YYYY-MM-DD'),
  docCategory: 'ALL',
  processingStatus: 'ALL',
  keyword: '',
})

const jobFilters = ref({
  status: 'ALL',
  keyword: '',
})

const entries = ref([])
const entriesTotal = ref(0)
const entriesAmount = ref(0)
const entryPage = ref(1)
const entryPageSize = ref(20)

const documents = ref([])
const documentsTotal = ref(0)
const docPage = ref(1)
const docPageSize = ref(20)

const jobs = ref([])
const jobsTotal = ref(0)
const jobPage = ref(1)
const jobPageSize = ref(20)

const entryTotalPages = computed(() => Math.max(1, Math.ceil(entriesTotal.value / entryPageSize.value)))
const docTotalPages = computed(() => Math.max(1, Math.ceil(documentsTotal.value / docPageSize.value)))
const jobTotalPages = computed(() => Math.max(1, Math.ceil(jobsTotal.value / jobPageSize.value)))

function onSelectFiles(event) {
  files.value = Array.from(event.target.files || [])
}

function formatDateTime(value) {
  if (!value) return '-'
  return dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : value
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2)
}

async function refreshMetaOptions() {
  const [types, categories] = await Promise.all([fetchInvoiceTypes(), fetchExpenseCategories()])
  invoiceTypes.value = types
  expenseCategories.value = categories
}

async function refreshEntries() {
  const data = await fetchEntries({
    ...entryFilters.value,
    page: entryPage.value,
    pageSize: entryPageSize.value,
  })
  entries.value = data.items || []
  entriesTotal.value = data.total || 0
  entriesAmount.value = data.totalAmount || 0
}

async function refreshDocuments() {
  const data = await fetchDocuments({
    ...docFilters.value,
    page: docPage.value,
    pageSize: docPageSize.value,
  })
  documents.value = data.items || []
  documentsTotal.value = data.total || 0
}

async function refreshJobs() {
  const data = await fetchOcrJobs({
    ...jobFilters.value,
    page: jobPage.value,
    pageSize: jobPageSize.value,
  })
  jobs.value = data.items || []
  jobsTotal.value = data.total || 0
}

async function refreshAll() {
  isLoading.value = true
  errorMessage.value = ''
  try {
    await Promise.all([refreshMetaOptions(), refreshEntries(), refreshDocuments(), refreshJobs()])
  } catch (err) {
    errorMessage.value = err?.response?.data?.message || err?.message || '刷新数据失败'
  } finally {
    isLoading.value = false
  }
}

async function submitUpload() {
  if (!files.value.length) {
    errorMessage.value = '请先选择文件'
    return
  }

  isUploading.value = true
  errorMessage.value = ''
  message.value = ''

  try {
    const result = await uploadDocuments(files.value)
    const trace = result?.traceId ? ` traceId=${result.traceId}` : ''
    message.value = `${result.message || '上传成功'}（文档 ${result.documentCount || 0} 条，抽取条目 ${result.entryCount || 0} 条）${trace}`
    files.value = []
    const fileInput = document.getElementById('invoice-files')
    if (fileInput) fileInput.value = ''
    await refreshAll()
  } catch (err) {
    const trace = err?.response?.data?.traceId ? ` traceId=${err.response.data.traceId}` : ''
    errorMessage.value = `${err?.response?.data?.message || err?.message || '上传失败'}${trace}`
  } finally {
    isUploading.value = false
  }
}

async function doSearchEntries() {
  entryPage.value = 1
  await refreshEntries()
}

async function doSearchDocuments() {
  docPage.value = 1
  await refreshDocuments()
}

async function doSearchJobs() {
  jobPage.value = 1
  await refreshJobs()
}

async function doExport() {
  isExporting.value = true
  errorMessage.value = ''
  try {
    const blob = await exportEntries({
      ...entryFilters.value,
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const start = entryFilters.value.startDate
    const end = entryFilters.value.endDate
    link.href = url
    link.download = `travel-expense-${start}-to-${end}.xlsx`
    link.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    errorMessage.value = err?.response?.data?.message || err?.message || '导出失败'
  } finally {
    isExporting.value = false
  }
}

async function changeEntryPage(nextPage) {
  entryPage.value = Math.min(Math.max(1, nextPage), entryTotalPages.value)
  await refreshEntries()
}

async function changeDocPage(nextPage) {
  docPage.value = Math.min(Math.max(1, nextPage), docTotalPages.value)
  await refreshDocuments()
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
      <h1>发票与差旅资料管理器</h1>
      <p>业务数据、文档清单、OCR日志已分离。先看“费用条目”，再看“文档清单”和“识别日志”。</p>
    </header>

    <section class="panel upload-panel">
      <h2>上传或补录文件</h2>
      <div class="upload-row">
        <input id="invoice-files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.bmp,.docx" @change="onSelectFiles" />
        <button :disabled="isUploading" @click="submitUpload">{{ isUploading ? '处理中...' : '上传并处理' }}</button>
        <button class="ghost" :disabled="isLoading" @click="refreshAll">刷新全部数据</button>
      </div>
      <p class="muted">支持发票与汇总文档（PDF/JPG/PNG/WEBP/BMP/DOCX）。</p>
      <p v-if="message" class="ok-message">{{ message }}</p>
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
    </section>

    <section class="panel tabs-panel">
      <div class="tab-row">
        <button :class="activeTab === 'entries' ? 'active-tab' : 'ghost'" @click="activeTab = 'entries'">费用条目</button>
        <button :class="activeTab === 'documents' ? 'active-tab' : 'ghost'" @click="activeTab = 'documents'">文档清单</button>
        <button :class="activeTab === 'jobs' ? 'active-tab' : 'ghost'" @click="activeTab = 'jobs'">识别日志</button>
      </div>
    </section>

    <section v-if="activeTab === 'entries'" class="panel">
      <h2>费用条目（业务查询）</h2>
      <div class="filters-grid">
        <label>
          日期维度
          <select v-model="entryFilters.dateField">
            <option value="UPLOAD_DATE">上传时间</option>
            <option value="INVOICE_DATE">发票日期</option>
          </select>
        </label>
        <label>开始日期 <input v-model="entryFilters.startDate" type="date" /></label>
        <label>结束日期 <input v-model="entryFilters.endDate" type="date" /></label>
        <label>
          发票类型
          <select v-model="entryFilters.type">
            <option value="ALL">全部</option>
            <option v-for="item in invoiceTypes" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label>
          费用分类
          <select v-model="entryFilters.expenseCategory">
            <option value="ALL">全部</option>
            <option v-for="item in expenseCategories" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="keyword">关键字 <input v-model.trim="entryFilters.keyword" type="text" placeholder="发票号/商家/路线/明细" /></label>
      </div>
      <div class="actions-row">
        <button @click="doSearchEntries">查询</button>
        <button :disabled="isExporting" @click="doExport">{{ isExporting ? '导出中...' : '导出 XLSX' }}</button>
      </div>
      <p class="summary">条目数: {{ entriesTotal }}，金额合计: {{ formatMoney(entriesAmount) }} 元</p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>上传时间</th>
              <th>发生日期</th>
              <th>类型</th>
              <th>分类</th>
              <th>金额</th>
              <th>销售方</th>
              <th>发票代码</th>
              <th>发票号码</th>
              <th>路线</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!entries.length">
              <td colspan="10" class="empty">暂无条目</td>
            </tr>
            <tr v-for="item in entries" :key="item.id">
              <td>{{ formatDateTime(item.createdAt) }}</td>
              <td>{{ item.occurredDate || '-' }}</td>
              <td>{{ item.invoiceType || '-' }}</td>
              <td>{{ item.expenseCategory || '-' }}</td>
              <td>{{ formatMoney(item.amount) }}</td>
              <td>{{ item.sellerName || '-' }}</td>
              <td>{{ item.invoiceCode || '-' }}</td>
              <td>{{ item.invoiceNumber || '-' }}</td>
              <td>{{ [item.routeFrom, item.routeTo].filter(Boolean).join(' -> ') || '-' }}</td>
              <td>{{ item.itemName || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button :disabled="entryPage <= 1" @click="changeEntryPage(entryPage - 1)">上一页</button>
        <span>第 {{ entryPage }} / {{ entryTotalPages }} 页</span>
        <button :disabled="entryPage >= entryTotalPages" @click="changeEntryPage(entryPage + 1)">下一页</button>
      </div>
    </section>

    <section v-if="activeTab === 'documents'" class="panel">
      <h2>文档清单（发票/汇总/其他）</h2>
      <div class="filters-grid">
        <label>
          日期维度
          <select v-model="docFilters.dateField">
            <option value="UPLOAD_DATE">上传时间</option>
            <option value="INVOICE_DATE">发票日期</option>
          </select>
        </label>
        <label>开始日期 <input v-model="docFilters.startDate" type="date" /></label>
        <label>结束日期 <input v-model="docFilters.endDate" type="date" /></label>
        <label>
          文档类别
          <select v-model="docFilters.docCategory">
            <option value="ALL">全部</option>
            <option value="INVOICE">发票</option>
            <option value="SUMMARY">汇总文档</option>
            <option value="OTHER">其他</option>
          </select>
        </label>
        <label>
          处理状态
          <select v-model="docFilters.processingStatus">
            <option value="ALL">全部</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="PARTIAL">PARTIAL</option>
            <option value="FAILED">FAILED</option>
            <option value="SKIPPED">SKIPPED</option>
          </select>
        </label>
        <label class="keyword">关键字 <input v-model.trim="docFilters.keyword" type="text" placeholder="文件名/类型/发票号" /></label>
      </div>
      <div class="actions-row">
        <button @click="doSearchDocuments">查询</button>
      </div>
      <p class="summary">文档数: {{ documentsTotal }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>上传时间</th>
              <th>文件名</th>
              <th>类别</th>
              <th>子类型</th>
              <th>状态</th>
              <th>标题</th>
              <th>金额</th>
              <th>发票号</th>
              <th>源文件</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!documents.length">
              <td colspan="9" class="empty">暂无文档</td>
            </tr>
            <tr v-for="item in documents" :key="item.id">
              <td>{{ formatDateTime(item.createdAt) }}</td>
              <td>{{ item.originalName }}</td>
              <td>{{ item.docCategory }}</td>
              <td>{{ item.docSubType }}</td>
              <td>{{ item.processingStatus }}</td>
              <td>{{ item.title }}</td>
              <td>{{ item.commonFields?.amount ?? '-' }}</td>
              <td>{{ item.commonFields?.invoiceNumber || '-' }}</td>
              <td><a :href="item.storedFilePath" target="_blank" rel="noreferrer">查看</a></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button :disabled="docPage <= 1" @click="changeDocPage(docPage - 1)">上一页</button>
        <span>第 {{ docPage }} / {{ docTotalPages }} 页</span>
        <button :disabled="docPage >= docTotalPages" @click="changeDocPage(docPage + 1)">下一页</button>
      </div>
    </section>

    <section v-if="activeTab === 'jobs'" class="panel">
      <h2>识别日志（OCR Pipeline）</h2>
      <div class="filters-grid two-col">
        <label>
          状态
          <select v-model="jobFilters.status">
            <option value="ALL">全部</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="PARTIAL">PARTIAL</option>
            <option value="FAILED">FAILED</option>
            <option value="SKIPPED">SKIPPED</option>
          </select>
        </label>
        <label class="keyword">关键字 <input v-model.trim="jobFilters.keyword" type="text" placeholder="traceId/requestId/错误信息" /></label>
      </div>
      <div class="actions-row">
        <button @click="doSearchJobs">查询</button>
      </div>
      <p class="summary">日志数: {{ jobsTotal }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>开始时间</th>
              <th>状态</th>
              <th>来源</th>
              <th>traceId</th>
              <th>耗时(ms)</th>
              <th>动作链路</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!jobs.length">
              <td colspan="7" class="empty">暂无日志</td>
            </tr>
            <tr v-for="job in jobs" :key="job.id">
              <td>{{ formatDateTime(job.startedAt) }}</td>
              <td>{{ job.status }}</td>
              <td>{{ job.source }}</td>
              <td>{{ job.traceId || '-' }}</td>
              <td>{{ job.elapsedMs }}</td>
              <td>{{ (job.actions || []).map(action => `${action.name}:${action.statusCode || '-'}:${action.requestId || '-'}`).join(' | ') || '-' }}</td>
              <td>{{ job.errorMessage || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button :disabled="jobPage <= 1" @click="changeJobPage(jobPage - 1)">上一页</button>
        <span>第 {{ jobPage }} / {{ jobTotalPages }} 页</span>
        <button :disabled="jobPage >= jobTotalPages" @click="changeJobPage(jobPage + 1)">下一页</button>
      </div>
    </section>
  </div>
</template>
