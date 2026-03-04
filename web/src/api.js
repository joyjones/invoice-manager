import axios from 'axios'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 240000,
})

export async function uploadDocuments(files) {
  const formData = new FormData()
  for (const file of files) {
    formData.append('files', file)
  }
  const { data } = await apiClient.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

export async function fetchEntries(params) {
  const { data } = await apiClient.get('/entries', { params })
  return data
}

export async function fetchDocuments(params) {
  const { data } = await apiClient.get('/documents', { params })
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
