/**
 * suggestions.js — inline apply/dismiss UI for GitLab suggestion blocks.
 *
 * Depends on:
 *   - suggestion-parser.js (loaded before this script, exposes window.SuggestionParser)
 *   - app.js bearer token (window.hulyBearer exported by app.js)
 *
 * CSP-safe: no inline event handlers. All handlers attached via addEventListener.
 * No external network calls except to the same origin /user/api/v1/suggestions/…
 */

;(function () {
  'use strict'

  const API_BASE = window.location.origin

  /**
   * Escape HTML for safe insertion into innerHTML.
   */
  function esc (text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * Retrieve the bearer token stored by app.js in sessionStorage or the
   * module-level variable. app.js writes `sessionStorage.hulyBearer` on
   * receipt of the huly-bearer postMessage.
   */
  function getBearer () {
    return sessionStorage.getItem('hulyBearer') ?? null
  }

  /**
   * Build the suggestion controls HTML for a single suggestion block.
   *
   * @param {string} bindingId
   * @param {string} mrIid
   * @param {string} noteId       - GitLab note id (string)
   * @param {number} suggestionId - numeric GitLab suggestion id
   * @param {string} content      - suggested replacement text
   * @param {number} blockIndex   - 0-based index when a note has multiple blocks
   * @returns {HTMLElement}
   */
  function buildSuggestionWidget (bindingId, mrIid, noteId, suggestionId, content, blockIndex) {
    const wrapper = document.createElement('div')
    wrapper.className = 'suggestion-block'
    wrapper.dataset.bindingId = bindingId
    wrapper.dataset.mrIid = mrIid
    wrapper.dataset.noteId = noteId
    wrapper.dataset.suggestionId = String(suggestionId)
    wrapper.dataset.blockIndex = String(blockIndex)

    const pre = document.createElement('pre')
    pre.className = 'suggestion-content'
    pre.textContent = content

    const controls = document.createElement('div')
    controls.className = 'suggestion-controls'

    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'btn btn-suggestion-apply'
    applyBtn.textContent = 'Apply suggestion'
    applyBtn.dataset.action = 'apply'

    const dismissBtn = document.createElement('button')
    dismissBtn.type = 'button'
    dismissBtn.className = 'btn btn-suggestion-dismiss'
    dismissBtn.textContent = 'Dismiss'
    dismissBtn.dataset.action = 'dismiss'

    const status = document.createElement('span')
    status.className = 'suggestion-status'

    controls.appendChild(applyBtn)
    controls.appendChild(dismissBtn)
    controls.appendChild(status)

    wrapper.appendChild(pre)
    wrapper.appendChild(controls)

    applyBtn.addEventListener('click', function () {
      handleApply(wrapper, applyBtn, dismissBtn, status)
    })

    dismissBtn.addEventListener('click', function () {
      handleDismiss(wrapper, dismissBtn, status)
    })

    return wrapper
  }

  /**
   * Handle Apply button click.
   */
  function handleApply (wrapper, applyBtn, dismissBtn, status) {
    const { bindingId, mrIid, suggestionId } = wrapper.dataset
    const bearer = getBearer()

    applyBtn.disabled = true
    dismissBtn.disabled = true
    status.textContent = 'Applying…'
    status.className = 'suggestion-status suggestion-status--pending'

    const headers = { 'Content-Type': 'application/json' }
    if (bearer !== null) headers['Authorization'] = 'Bearer ' + bearer

    fetch(
      API_BASE + '/user/api/v1/suggestions/' + encodeURIComponent(bindingId) +
        '/' + encodeURIComponent(mrIid) +
        '/' + encodeURIComponent(suggestionId) + '/apply',
      { method: 'POST', headers: headers, credentials: 'include' }
    ).then(function (res) {
      if (res.ok) {
        return res.json().then(function (data) {
          status.textContent = 'Applied' + (data.commitSha ? ' (' + esc(data.commitSha.slice(0, 8)) + ')' : '')
          status.className = 'suggestion-status suggestion-status--ok'
          applyBtn.style.display = 'none'
          dismissBtn.style.display = 'none'
        })
      }
      return res.json().then(function (data) {
        status.textContent = 'Failed: ' + esc((data && data.message) ? data.message : 'Unknown error')
        status.className = 'suggestion-status suggestion-status--err'
        applyBtn.disabled = false
        dismissBtn.disabled = false
      })
    }).catch(function (err) {
      status.textContent = 'Error: ' + esc(err.message)
      status.className = 'suggestion-status suggestion-status--err'
      applyBtn.disabled = false
      dismissBtn.disabled = false
    })
  }

  /**
   * Handle Dismiss button click.
   */
  function handleDismiss (wrapper, dismissBtn, status) {
    const { bindingId, mrIid, noteId } = wrapper.dataset
    const bearer = getBearer()

    dismissBtn.disabled = true
    status.textContent = 'Dismissing…'
    status.className = 'suggestion-status suggestion-status--pending'

    const headers = { 'Content-Type': 'application/json' }
    if (bearer !== null) headers['Authorization'] = 'Bearer ' + bearer

    fetch(
      API_BASE + '/user/api/v1/suggestions/' + encodeURIComponent(bindingId) +
        '/' + encodeURIComponent(mrIid) +
        '/' + encodeURIComponent(noteId) + '/dismiss',
      { method: 'POST', headers: headers, credentials: 'include' }
    ).then(function (res) {
      if (res.ok) {
        wrapper.classList.add('suggestion-block--dismissed')
        status.textContent = 'Dismissed'
        status.className = 'suggestion-status suggestion-status--ok'
        dismissBtn.style.display = 'none'
        wrapper.querySelector('.btn-suggestion-apply').style.display = 'none'
      } else {
        return res.json().then(function (data) {
          status.textContent = 'Failed: ' + esc((data && data.message) ? data.message : 'Unknown error')
          status.className = 'suggestion-status suggestion-status--err'
          dismissBtn.disabled = false
        })
      }
    }).catch(function (err) {
      status.textContent = 'Error: ' + esc(err.message)
      status.className = 'suggestion-status suggestion-status--err'
      dismissBtn.disabled = false
    })
  }

  /**
   * Render suggestion widgets into a container element that has
   * data-binding-id, data-mr-iid, data-note-id, data-note-body attributes.
   * The suggestion id is approximated as noteId when a real GitLab suggestion
   * id is not available (single-suggestion notes). Multi-suggestion notes
   * encode suggestionId as noteId * 1000 + blockIndex as a placeholder.
   *
   * In production the note body comes from the Huly mirror. The suggestion id
   * should ideally be retrieved from the GitLab discussions API and embedded
   * as data-suggestion-ids (comma-separated). When not present, the noteId
   * is used so the endpoint receives the note-scoped identifier.
   *
   * @param {HTMLElement} container
   */
  function renderSuggestionsInContainer (container) {
    const body = container.dataset.noteBody
    const bindingId = container.dataset.bindingId
    const mrIid = container.dataset.mrIid
    const noteId = container.dataset.noteId
    const rawSuggestionIds = container.dataset.suggestionIds

    if (!body || !bindingId || !mrIid || !noteId) return

    const parser = window.SuggestionParser
    if (!parser) return

    const blocks = parser.parseSuggestions(body)
    if (blocks.length === 0) return

    // suggestionIds may be pre-populated from the server as a comma-separated list
    const suggestionIds = rawSuggestionIds
      ? rawSuggestionIds.split(',').map(function (s) { return parseInt(s.trim(), 10) })
      : []

    const fragment = document.createDocumentFragment()
    blocks.forEach(function (block, i) {
      const sid = (suggestionIds[i] !== undefined && !isNaN(suggestionIds[i]))
        ? suggestionIds[i]
        : parseInt(noteId, 10) * 1000 + i
      const widget = buildSuggestionWidget(bindingId, mrIid, noteId, sid, block.content, i)
      fragment.appendChild(widget)
    })
    container.appendChild(fragment)
  }

  /**
   * Scan the document for all .suggestion-container elements and render
   * widgets. Call this after new note elements are inserted into the DOM.
   */
  function renderAll () {
    const containers = document.querySelectorAll('.suggestion-container[data-note-body]')
    containers.forEach(renderSuggestionsInContainer)
  }

  // Auto-render on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll)
  } else {
    renderAll()
  }

  // Expose for programmatic use (e.g. after dynamic note injection)
  window.HulySuggestions = { renderAll: renderAll, renderContainer: renderSuggestionsInContainer }
}())
