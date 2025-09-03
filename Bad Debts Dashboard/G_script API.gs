/**
 * Google Apps Script: Data API for Bad Debts Dashboard
 *
 * Reads all rows from Spreadsheet: "Student Collections Dashboard"
 * Tab: "Master Student Tracker"
 * Returns JSON (or JSONP if callback provided) for client-side filtering/aggregation.
 *
 * Deploy: Deploy → New deployment → Web app → Execute as Me → Anyone with the link
 * URL example: https://script.google.com/macros/s/DEPLOYMENT_ID/exec?format=json
 * JSONP example: https://script.google.com/macros/s/DEPLOYMENT_ID/exec?callback=handleData
 */

/** CONFIGURATION **/
var CONFIG = {
  // Prefer setting spreadsheetId from the Google Sheets URL: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
  spreadsheetId: '',
  // Fallback by name (used only if spreadsheetId is empty). Less reliable if multiple files share the same name.
  spreadsheetName: 'Student Collections Dashboard',
  sheetName: 'Master Student Tracker',
  cacheSeconds: 300,
  includeOriginalHeaders: false
};

function getSpreadsheet_() {
  if (CONFIG.spreadsheetId && CONFIG.spreadsheetId.trim()) {
    return SpreadsheetApp.openById(CONFIG.spreadsheetId.trim());
  }
  // Fallback: find by name via Drive (first match)
  var files = DriveApp.getFilesByName(CONFIG.spreadsheetName);
  if (!files.hasNext()) {
    throw new Error('Spreadsheet not found by name: ' + CONFIG.spreadsheetName + '. Set CONFIG.spreadsheetId for reliability.');
  }
  var file = files.next();
  return SpreadsheetApp.openById(file.getId());
}

/**
 * HTTP GET endpoint. Supports JSON and JSONP (via ?callback=fn).
 */
function doGet(e) {
  try {
    var callback = e && e.parameter && e.parameter.callback;

    var payload = fetchAllData_();

    // JSONP response if callback specified
    if (callback) {
      var jsonp = callback + '(' + JSON.stringify(payload) + ')';
      return ContentService
        .createTextOutput(jsonp)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    // Default JSON response
    return ContentService
      .createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var errorPayload = { success: false, error: String(err && err.message ? err.message : err) };
    return ContentService
      .createTextOutput(JSON.stringify(errorPayload))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function safeCachePut_(key, valueString, seconds) {
  try {
    // CacheService value must be <= 100KB. Leave headroom.
    if (valueString && valueString.length <= 90000) {
      CacheService.getScriptCache().put(key, valueString, seconds);
      return true;
    }
  } catch (err) {
    // ignore cache errors
  }
  return false;
}

function safeCacheGet_(key) {
  try {
    return CacheService.getScriptCache().get(key);
  } catch (err) {
    return null;
  }
}

/**
 * Reads, normalizes and returns all sheet rows with caching.
 */
function fetchAllData_() {
  var cacheKey = 'all_rows_v1';
  var cached = safeCacheGet_(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var ss = getSpreadsheet_();
  if (!ss) throw new Error('Spreadsheet not opened');
  var sh = ss.getSheetByName(CONFIG.sheetName);
  if (!sh) throw new Error('Sheet not found: ' + CONFIG.sheetName);

  var range = sh.getDataRange();
  var values = range.getValues();
  if (!values || values.length < 2) {
    var emptyPayload = { success: true, meta: buildMeta_(0), columns: [], data: [] };
    safeCachePut_(cacheKey, JSON.stringify(emptyPayload), CONFIG.cacheSeconds);
    return emptyPayload;
  }

  var headers = (values[0] || []).map(function(h) { return String(h || '').trim(); });
  var headerMap = buildHeaderMap_(headers);

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (isRowEmpty_(row)) continue;
    var obj = rowToObject_(row, headerMap);
    rows.push(obj);
  }

  var payload = {
    success: true,
    meta: buildMeta_(rows.length),
    columns: headers,
    data: rows,
    debug: {
      installmentStatusColumn: headerMap['Installment_status'] ? headerMap['Installment_status'].original : 'NOT_FOUND',
      installmentStatusIndex: headerMap['Installment_status'] ? headerMap['Installment_status'].index : -1,
      installmentCandidates: headerMap['__installment_debug'] ? headerMap['__installment_debug'].allCandidates : [],
      chosenColumn: headerMap['__installment_debug'] ? headerMap['__installment_debug'].chosenColumn : 'NONE',
      allHeaders: headers,
      sampleDataKeys: rows.length > 0 ? Object.keys(rows[0]) : []
    }
  };

  var json = JSON.stringify(payload);
  safeCachePut_(cacheKey, json, CONFIG.cacheSeconds);
  return payload;
}

/**
 * Builds response metadata.
 */
function buildMeta_(rowCount) {
  return {
    sheet: CONFIG.sheetName,
    spreadsheet: CONFIG.spreadsheetName,
    rowCount: rowCount,
    fetchedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd\'T\'HH:mm:ssXXX')
  };
}

/**
 * Maps headers to canonical keys used by the frontend. Case-insensitive.
 */
function buildHeaderMap_(headers) {
  var canonical = {
    'scheme_id': 'scheme_id',
    'regno': 'regno',
    'scheme': 'scheme',
    'source_name': 'source_name',
    'course': 'course',
    'center': 'center',
    'joining_date': 'joining_date',
    'count_installment': 'count_installment',
    'status_new_logic': 'status_new_logic',
    // Note: installment_status is handled separately below to prioritize Column R
    'new_receipt_date': 'new_receipt_date',
    'total_collection_cr': 'total_collection_cr',
    'total_balance_cr': 'total_balance_cr',
    'total_payable_cr': 'total_payable_cr',
    'remainingamount': 'RemainingAmount',
    'next_unpaid_duedate': 'Next_Unpaid_DueDate',
    'next_unpaid_amount': 'Next_Unpaid_Amount',
    'our_status': 'Our_Status',
    'baddebt': 'BadDebt',
    'bad_debt': 'BadDebt'
  };

  var map = {};
  var installmentCandidates = [];

  for (var c = 0; c < headers.length; c++) {
    var original = headers[c];
    var keyLower = normalizeKey_(original);

    // collect candidates for installment status; we'll decide later
    if (keyLower === 'installment_status' || keyLower === 'installmentstatus') {
      installmentCandidates.push({ index: c, original: original });
      continue;
    }

    var targetKey = canonical.hasOwnProperty(keyLower) ? canonical[keyLower] : keyLower;
    map[targetKey] = { index: c, original: original };
  }

  // Prefer column whose original header equals 'Installment_status' (R), else the last candidate
  if (installmentCandidates.length > 0) {
    var chosen = null;
    for (var i = 0; i < installmentCandidates.length; i++) {
      var cand = installmentCandidates[i];
      if (String(cand.original).trim() === 'Installment_status') {
        chosen = cand; break;
      }
    }
    if (!chosen) chosen = installmentCandidates[installmentCandidates.length - 1];
    // Use 'Installment_status' as key to match frontend expectations
    map['Installment_status'] = chosen;
    
    // Store debug info about all candidates
    map['__installment_debug'] = {
      allCandidates: installmentCandidates.map(function(c) { return c.original; }),
      chosenColumn: chosen ? chosen.original : 'NONE',
      chosenIndex: chosen ? chosen.index : -1
    };
  }

  return map;
}

/**
 * Converts a sheet row to object using the provided header map.
 */
function rowToObject_(row, headerMap) {
  var obj = {};

  // Helper to get cell by canonical key
  function get(key) {
    var meta = headerMap[key];
    if (!meta) return '';
    return row[meta.index];
  }

  // Extract values with canonical keys
  obj.scheme_id = toStringSafe_(get('scheme_id'));
  obj.regno = toStringSafe_(get('regno'));
  obj.scheme = toStringSafe_(get('scheme'));
  obj.source_name = toStringSafe_(get('source_name'));
  obj.course = toStringSafe_(get('course'));
  obj.center = toStringSafe_(get('center'));
  obj.joining_date = toIsoDate_(get('joining_date'));
  obj.count_installment = toNumberSafe_(get('count_installment'));
  obj.status_new_logic = toStringSafe_(get('status_new_logic'));
  obj.Installment_status = toStringSafe_(get('Installment_status'));
  obj.new_receipt_date = toIsoDate_(get('new_receipt_date'));
  obj.total_collection_cr = toNumberSafe_(get('total_collection_cr'));
  obj.total_balance_cr = toNumberSafe_(get('total_balance_cr'));
  obj.total_payable_cr = toNumberSafe_(get('total_payable_cr'));
  obj.RemainingAmount = toNumberSafe_(get('RemainingAmount'));
  obj.Next_Unpaid_DueDate = toIsoDate_(get('Next_Unpaid_DueDate'));
  obj.Next_Unpaid_Amount = toNumberSafe_(get('Next_Unpaid_Amount'));
  obj.Our_Status = toStringSafe_(get('Our_Status'));
  obj.BadDebt = toNumberSafe_(get('BadDebt'));

  if (CONFIG.includeOriginalHeaders) {
    obj.__original = {};
    for (var key in headerMap) {
      if (!headerMap.hasOwnProperty(key)) continue;
      var meta = headerMap[key];
      obj.__original[meta.original] = row[meta.index];
    }
  }

  return obj;
}

/**
 * Test function you can run manually in Apps Script editor to debug
 */
function testColumnMapping() {
  try {
    var result = fetchAllData_();
    console.log('=== COLUMN MAPPING TEST ===');
    console.log('Success:', result.success);
    console.log('Total rows:', result.data.length);
    console.log('Debug info:', JSON.stringify(result.debug, null, 2));
    
    if (result.data.length > 0) {
      console.log('Sample row keys:', Object.keys(result.data[0]));
      console.log('Sample Installment_status value:', result.data[0].Installment_status);
      
      // Check for fully paid students
      var fullyPaidCount = 0;
      for (var i = 0; i < Math.min(10, result.data.length); i++) {
        var status = String(result.data[i].Installment_status || '');
        if (/fully\s*paid/i.test(status)) {
          fullyPaidCount++;
        }
      }
      console.log('Fully paid students in first 10 rows:', fullyPaidCount);
    }
    
    return result;
  } catch (e) {
    console.error('Test failed:', e.toString());
    return { error: e.toString() };
  }
}

/** Utilities **/
function isRowEmpty_(row) {
  for (var i = 0; i < row.length; i++) {
    var v = row[i];
    if (v !== '' && v !== null && typeof v !== 'undefined') return false;
  }
  return true;
}

function normalizeKey_(header) {
  var s = String(header || '').toLowerCase().trim();
  // remove non-alphanumeric except spaces and underscores
  s = s.replace(/[^a-z0-9 _]/g, '');
  // collapse whitespace to underscores
  s = s.replace(/\s+/g, '_');

  // Special-case mapping for known duplicates/casing variations
  if (s === 'installment_status') return 'installment_status';
  if (s === 'remaining_amount' || s === 'remainingamount') return 'remainingamount';
  if (s === 'next_unpaid_duedate' || s === 'nextunpaid_duedate') return 'next_unpaid_duedate';
  if (s === 'next_unpaid_amount' || s === 'nextunpaid_amount') return 'next_unpaid_amount';
  if (s === 'baddebt' || s === 'bad_debt') return 'baddebt';

  // If there are two identical headers in sheet like "Installment_status" and "installment_status",
  // the canonical map will handle one as duplicate key.
  return s;
}

function toStringSafe_(v) {
  if (v === null || typeof v === 'undefined') return '';
  if (v instanceof Date) return toIsoDate_(v);
  return String(v).trim();
}

function toNumberSafe_(v) {
  if (v === null || typeof v === 'undefined' || v === '') return 0;
  if (typeof v === 'number') return v;
  var num = Number(String(v).replace(/[,\s]/g, ''));
  return isNaN(num) ? 0 : num;
}

function toIsoDate_(v) {
  var d = null;
  if (v instanceof Date) d = v; else if (v) d = new Date(v);
  if (!d || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Optional: Manual cache invalidation endpoint. Call with ?action=purgeCache
 */
function doPost(e) {
  try {
    var action = e && e.parameter && e.parameter.action;
    if (action === 'purgeCache') {
      CacheService.getScriptCache().remove('all_rows_v1');
      var ok = { success: true, message: 'Cache purged' };
      return ContentService.createTextOutput(JSON.stringify(ok)).setMimeType(ContentService.MimeType.JSON);
    }
    var bad = { success: false, error: 'Unsupported action' };
    return ContentService.createTextOutput(JSON.stringify(bad)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var errorPayload = { success: false, error: String(err && err.message ? err.message : err) };
    return ContentService.createTextOutput(JSON.stringify(errorPayload)).setMimeType(ContentService.MimeType.JSON);
  }
}
