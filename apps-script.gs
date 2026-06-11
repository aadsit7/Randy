/**
 * Randy — Recast SE backend (Google Apps Script).
 *
 * Setup (one time):
 *   1. Open the Recast SE Google Sheet.
 *   2. Extensions → Apps Script. Replace any existing code with this file.
 *   3. Make sure your Anthropic API key lives in the "Config" tab as a row:
 *         A: anthropic_api_key   B: sk-ant-api03-...
 *      (You can also store it in Project Settings → Script Properties under
 *      ANTHROPIC_API_KEY — the Config tab wins if both are present.)
 *   4. Deploy → New deployment → Type: Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the /exec URL.
 *   5. Paste that URL into Randy's Settings → "Apps Script Proxy URL".
 *      You do not need to enter an Anthropic API key in the app anymore.
 *
 * Endpoints:
 *   GET  ?action=list_history          → { history: [{session_id, date, timestamp, pairs:[{question,answer}]}] }
 *   GET  ?action=ping                  → { ok:true, has_api_key:bool, sheet:"Randy Tasks" }
 *   GET  (no action)                   → { ok:true, has_api_key:bool }  (key is never returned)
 *   POST { action:"chat", system, messages, model?, max_tokens?, tools?,
 *          output_config?, session_id?, save?:true }
 *                                      → { ok:true, reply, sources, model, usage }
 *   POST { question, answer, sources?, model?, session_id? }  (legacy save)
 *                                      → { ok:true }
 *   POST { action:"delete_history", session_id }
 *                                      → { ok:true, removed:N }
 *   POST { action:"save_config", config:{...} }   (legacy, ignored)
 *                                      → { ok:true }
 */

var TASKS_SHEET   = 'Randy Tasks';
var CONFIG_SHEET  = 'Config';
var TASKS_HEADERS = ['Question', 'Answer', 'Sources', 'Date', 'Model', 'Session_ID'];

var ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
var DEFAULT_MODEL     = 'claude-sonnet-4-6';
var DEFAULT_MAX_TOK   = 2048;

// Transient Anthropic statuses worth retrying (rate limit / overload / 5xx).
var RETRYABLE_STATUS  = [429, 500, 502, 503, 529];
var MAX_RETRIES       = 2;       // total attempts = 1 + MAX_RETRIES
var MAX_CONTINUATIONS = 3;       // pause_turn re-sends for server-side tool loops

/* ---------- HTTP entry points ---------- */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'list_history') return _json(listHistory_());
    if (action === 'ping' || !action) {
      return _json({ ok: true, has_api_key: !!getApiKey_(), sheet: TASKS_SHEET });
    }
    return _json({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return _json({ ok: false, error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return _json({ ok: false, error: 'Invalid JSON body' });
  }
  var action = body.action || (Array.isArray(body.messages) ? 'chat'
                              : (body.question && body.answer ? 'save' : ''));
  try {
    if (action === 'chat')           return _json(handleChat_(body));
    if (action === 'save')           return _json(appendRow_(body));
    if (action === 'delete_history') return _json(deleteHistory_(body));
    if (action === 'save_config')    return _json({ ok: true }); // ignored on purpose
    return _json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return _json({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ---------- Chat proxy ---------- */

function handleChat_(body) {
  var apiKey = getApiKey_();
  if (!apiKey) {
    return {
      ok: false,
      error: 'No Anthropic API key configured. Add it to the Config tab '
           + '(row: anthropic_api_key | sk-ant-…) or in Apps Script → '
           + 'Project Settings → Script Properties as ANTHROPIC_API_KEY.'
    };
  }

  var payload = {
    model:      String(body.model || DEFAULT_MODEL),
    max_tokens: Number(body.max_tokens) || DEFAULT_MAX_TOK,
    stream:     false, // Apps Script can't stream back to the browser
    // `system` may be a plain string or an array of text blocks (the client
    // sends an array with cache_control so the persona prefix gets cached).
    system:     body.system || '',
    messages:   Array.isArray(body.messages) ? body.messages : []
  };
  if (Array.isArray(body.tools) && body.tools.length) payload.tools = body.tools;
  if (body.output_config && typeof body.output_config === 'object') {
    payload.output_config = body.output_config;
  }

  var parsed = fetchAnthropic_(apiKey, payload);
  if (parsed.ok === false) return parsed;

  // Server-side tools (web search) can pause the sampling loop. Re-send the
  // conversation with the assistant turn appended and the API resumes where
  // it left off. Bounded so a misbehaving loop can't run forever.
  var continuations = 0;
  while (parsed.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
    continuations++;
    var resumed = {
      model:      payload.model,
      max_tokens: payload.max_tokens,
      stream:     false,
      system:     payload.system,
      messages:   payload.messages.concat([{ role: 'assistant', content: parsed.content }])
    };
    if (payload.tools) resumed.tools = payload.tools;
    if (payload.output_config) resumed.output_config = payload.output_config;
    var next = fetchAnthropic_(apiKey, resumed);
    if (next.ok === false) break; // keep what we have rather than failing the turn
    parsed = next;
  }

  var extracted = extractReply_(parsed);

  if (body.save !== false && extracted.text) {
    try {
      var question = lastUserText_(payload.messages);
      if (question) {
        appendRow_({
          question:   question,
          answer:     extracted.text,
          sources:    extracted.sources.join(', '),
          model:      payload.model,
          session_id: body.session_id || ''
        });
      }
    } catch (saveErr) {
      // Don't fail the chat response just because the save failed.
      console.warn('Auto-save failed: ' + saveErr);
    }
  }

  return {
    ok:          true,
    reply:       extracted.text,
    sources:     extracted.sources,
    model:       parsed.model,
    stop_reason: parsed.stop_reason,
    usage:       parsed.usage
  };
}

// One Anthropic round trip with bounded retry on transient failures.
// Returns the parsed response object, or { ok:false, error } on hard failure.
function fetchAnthropic_(apiKey, payload) {
  var lastError = 'Anthropic request failed';
  for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) Utilities.sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s
    var res;
    try {
      res = UrlFetchApp.fetch(ANTHROPIC_URL, {
        method:             'post',
        contentType:        'application/json',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        payload:            JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (netErr) {
      lastError = 'Network error: ' + String((netErr && netErr.message) || netErr);
      continue;
    }

    var status = res.getResponseCode();
    var text   = res.getContentText();

    if (status >= 200 && status < 300) {
      try { return JSON.parse(text); }
      catch (err) { return { ok: false, error: 'Bad response from Anthropic' }; }
    }

    var msg = 'Anthropic API error (' + status + ')';
    try {
      var j = JSON.parse(text);
      if (j && j.error && j.error.message) msg = j.error.message;
    } catch (e2) {}
    lastError = msg;

    if (RETRYABLE_STATUS.indexOf(status) === -1) {
      return { ok: false, status: status, error: msg };
    }
  }
  return { ok: false, error: lastError };
}

function lastUserText_(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    var m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      var parts = [];
      for (var k = 0; k < m.content.length; k++) {
        var block = m.content[k];
        if (block && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      return parts.join('\n');
    }
    return '';
  }
  return '';
}

function extractReply_(parsed) {
  var text = '';
  var sources = [];
  var blocks = Array.isArray(parsed && parsed.content) ? parsed.content : [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text;
      if (Array.isArray(b.citations)) {
        for (var c = 0; c < b.citations.length; c++) {
          var cit = b.citations[c];
          if (cit && cit.url && sources.indexOf(cit.url) === -1) sources.push(cit.url);
        }
      }
    } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (var r = 0; r < b.content.length; r++) {
        var hit = b.content[r];
        if (hit && hit.url && sources.indexOf(hit.url) === -1) sources.push(hit.url);
      }
    }
  }
  return { text: text, sources: sources };
}

/* ---------- Sheet ops ---------- */

function appendRow_(body) {
  var sheet = getTasksSheet_();
  var date  = body.date || _formatDate_(new Date());
  var answer = String(body.answer || '');
  if (answer.length > 50000) answer = answer.substring(0, 50000);
  sheet.appendRow([
    String(body.question || ''),
    answer,
    String(body.sources || ''),
    date,
    String(body.model || ''),
    String(body.session_id || '')
  ]);
  return { ok: true };
}

function listHistory_() {
  var sheet = getTasksSheet_();
  var last  = sheet.getLastRow();
  if (last < 2) return { history: [] };
  var values = sheet.getRange(2, 1, last - 1, TASKS_HEADERS.length).getValues();
  var groups = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var question = row[0], answer = row[1], date = row[3], sessionId = row[5];
    if (!sessionId) continue;
    var key = String(sessionId);
    if (!groups[key]) groups[key] = { session_id: key, date: '', timestamp: 0, pairs: [] };
    var ts = 0;
    if (date instanceof Date)      ts = date.getTime();
    else if (typeof date === 'string') ts = Date.parse(date) || 0;
    if (ts > groups[key].timestamp) groups[key].timestamp = ts;
    if (!groups[key].date && date) groups[key].date = (date instanceof Date) ? _formatDate_(date) : String(date);
    groups[key].pairs.push({ question: String(question || ''), answer: String(answer || '') });
  }
  var list = [];
  for (var k in groups) if (Object.prototype.hasOwnProperty.call(groups, k)) list.push(groups[k]);
  list.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
  return { history: list };
}

function deleteHistory_(body) {
  // Entry ids are session_id + '-' + timestamp; session ids contain hyphens
  // themselves, so strip only the trailing timestamp segment.
  var sessionId = String(body.session_id || (body.id ? String(body.id).replace(/-\d+$/, '') : '')).trim();
  if (!sessionId) return { ok: false, error: 'Missing session_id' };
  var sheet = getTasksSheet_();
  var last  = sheet.getLastRow();
  if (last < 2) return { ok: true, removed: 0 };
  var ids = sheet.getRange(2, 6, last - 1, 1).getValues();
  var removed = 0;
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === sessionId) {
      sheet.deleteRow(i + 2);
      removed++;
    }
  }
  return { ok: true, removed: removed };
}

function getTasksSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TASKS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TASKS_SHEET);
    sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ---------- Config + helpers ---------- */

function getApiKey_() {
  var fromSheet = readConfigValue_('anthropic_api_key');
  if (fromSheet) return fromSheet;
  return PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || '';
}

function readConfigValue_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) return '';
  var last = sheet.getLastRow();
  if (last < 2) return '';
  var rows = sheet.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) return String(rows[i][1] || '').trim();
  }
  return '';
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _formatDate_(d) {
  // Match the sheet's locale (M/D/YYYY) used by the legacy save path.
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/Chicago', 'M/d/yyyy h:mm:ss a');
}
