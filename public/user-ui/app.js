let bearer = null
let currentStatus = null
const API_BASE = window.location.origin
const DEFAULT_GITLAB_URL = 'https://gitlab.com'
const statusDisplay = document.getElementById('status-display')
const linkForm = document.getElementById('link-form')
const gitlabUrlInput = document.getElementById('gitlab-url')
const errorMessage = document.getElementById('error-message')
const formSection = document.getElementById('form-section')

/**
 * Get allowed parent origins from window global or meta tag.
 * Returns null if no allowlist is configured (fail-closed: reject all postMessages).
 * Returns array of allowed origins if configured.
 */
function getAllowedOrigins () {
  // Check window.HULY_PARENT_ORIGINS first
  if (window.HULY_PARENT_ORIGINS && Array.isArray(window.HULY_PARENT_ORIGINS)) {
    return window.HULY_PARENT_ORIGINS
  }
  // Check data-allowed-origins meta tag
  const metaTag = document.querySelector('meta[data-allowed-origins]')
  if (metaTag && metaTag.getAttribute('data-allowed-origins')) {
    const origins = metaTag.getAttribute('data-allowed-origins').split(',').map(o => o.trim()).filter(o => o)
    return origins.length > 0 ? origins : null
  }
  return null
}

/**
 * Validate postMessage origin against allowlist.
 * Returns true if origin is allowed, false otherwise.
 * If no allowlist configured, returns false (fail-closed).
 */
function isOriginAllowed (origin) {
  const allowedOrigins = getAllowedOrigins()
  if (!allowedOrigins) return false
  return allowedOrigins.includes(origin)
}

function acquireBearer () {
  const params = new URLSearchParams(window.location.search)
  if (params.has('bearer')) {
    console.warn('Bearer in query string rejected. Use postMessage or sessionStorage.')
  }
  const sessionBearer = sessionStorage.getItem('hulyBearer')
  if (sessionBearer) {
    bearer = sessionBearer
  }
}

window.addEventListener('message', (e) => {
  // Validate origin before processing any postMessage
  if (!isOriginAllowed(e.origin)) {
    console.warn(`postMessage from unauthorized origin rejected: ${e.origin}`)
    return
  }
  if (e.data?.type === 'huly-bearer') {
    bearer = e.data.token
    if (e.data.workspaceUuid) sessionStorage.setItem('hulyWorkspaceUuid', e.data.workspaceUuid)
    if (e.data.personUuid) sessionStorage.setItem('hulyPersonUuid', e.data.personUuid)
    loadStatus()
  }
})

async function loadStatus () {
  try {
    statusDisplay.innerHTML = '<p>Loading...</p>'
    const gitlabBaseUrl = gitlabUrlInput.value || DEFAULT_GITLAB_URL
    const headers = { 'Content-Type': 'application/json' }
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`
    const response = await fetch(`${API_BASE}/user/oauth/status?gitlabBaseUrl=${encodeURIComponent(gitlabBaseUrl)}`,
      { headers, credentials: 'include' })
    if (!response.ok) {
      if (response.status === 401) { showNoBearerMessage(); return }
      throw new Error(`HTTP ${response.status}`)
    }
    const data = await response.json()
    currentStatus = data
    if (data.linked && data.username) {
      statusDisplay.innerHTML = `<div style="text-align: center;"><p style="color: #059669; font-weight: 600; margin-bottom: 1rem;">✓ Linked as <strong>${escapeHtml(data.username)}</strong></p><button type="button" class="btn btn-danger" onclick="unlink()">Unlink Account</button></div>`
      formSection.style.display = 'none'
    } else {
      statusDisplay.innerHTML = '<p>Not linked yet</p>'
      formSection.style.display = 'block'
    }
    hideError()
  } catch (err) {
    showError(`Failed to load status: ${err.message}`)
  }
}

async function startLink (e) {
  e.preventDefault()
  const gitlabBaseUrl = gitlabUrlInput.value
  if (!gitlabBaseUrl.trim()) { showError('Please enter a GitLab instance URL'); return }
  try {
    const params = new URLSearchParams({ gitlabBaseUrl, returnTo: window.location.href })
    window.location.href = `${API_BASE}/user/oauth/start?${params}`
  } catch (err) {
    showError(`Failed to start linking: ${err.message}`)
  }
}

async function unlink () {
  if (!confirm('Unlink your GitLab account?')) return
  try {
    const gitlabBaseUrl = gitlabUrlInput.value || DEFAULT_GITLAB_URL
    const headers = { 'Content-Type': 'application/json' }
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`
    const response = await fetch(`${API_BASE}/user/oauth/credential`,
      { method: 'DELETE', headers, credentials: 'include', body: JSON.stringify({ gitlabBaseUrl }) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await loadStatus()
    showError('Account unlinked successfully', false)
  } catch (err) {
    showError(`Failed to unlink account: ${err.message}`)
  }
}

function showError (msg, isErr = true) {
  errorMessage.textContent = msg
  errorMessage.style.display = 'block'
  errorMessage.className = isErr ? 'error-message' : 'success-message'
}

function hideError () {
  errorMessage.style.display = 'none'
}

function showNoBearerMessage () {
  statusDisplay.innerHTML = '<div style="text-align: center; color: #7f1d1d;"><p style="margin-bottom: 0.5rem;">This page must be opened from within Huly.</p><p style="font-size: 0.875rem;">Or set <code>huly-bearer</code> in sessionStorage.</p></div>'
  formSection.style.display = 'none'
}

function escapeHtml (text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function handleCallback () {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('status')
  const error = params.get('error')
  if (status === 'linked') showError('Account linked successfully!', false)
  else if (error) showError(`Linking failed: ${escapeHtml(error)}`)
  if (status || error) window.history.replaceState({}, document.title, window.location.pathname)
}

function init () {
  gitlabUrlInput.value = DEFAULT_GITLAB_URL
  linkForm.addEventListener('submit', startLink)
  acquireBearer()
  handleCallback()
  if (bearer) {
    loadStatus()
  } else {
    setTimeout(() => { bearer ? loadStatus() : showNoBearerMessage() }, 100)
  }
  const allowedOrigins = getAllowedOrigins()
  if (allowedOrigins !== null && allowedOrigins.length > 0) {
    window.parent.postMessage({ type: 'huly-ui-ready' }, allowedOrigins[0])
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
