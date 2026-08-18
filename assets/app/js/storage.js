/**
 * 普算移动端 · 存储层
 * 对应桌面版 backend/storage.py。数据经 PusuanNative 桥落盘到应用私有目录
 * files/data/（与桌面版 data/ 目录结构一一对应：models.json / index.json /
 * convs/{id}/main.json / archives.json / settings.json / knowledge/ 等）。
 * 桌面版为每对话一个文件夹（main.json + subagents/ + tasks/），移动端同样保留。
 */
(function (global) {
  'use strict';

  var N = global.PusuanNative;

  function uid8() {
    var s = '';
    var chars = '0123456789abcdef';
    for (var i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * 16)];
    return s;
  }

  function now() { return Date.now() / 1000; }

  // ── 底层 JSON 读写 ──
  function readJson(rel, def) {
    var raw = N.readFile(rel);
    if (raw === null || raw === undefined || raw === '') return def !== undefined ? def : {};
    try { return JSON.parse(raw); } catch (e) { return def !== undefined ? def : {}; }
  }

  function writeJson(rel, data) {
    return N.writeFile(rel, JSON.stringify(data, null, 2));
  }

  // ── 路径常量（对应 storage.py） ──
  var DATA_DIR = '';
  var MODELS_FILE = 'models.json';
  var INDEX_FILE = 'index.json';
  var CONVS_DIR = 'convs';
  var ARCHIVES_FILE = 'archives.json';
  var ARCHIVES_DIR = 'archives';
  var SETTINGS_FILE = 'settings.json';

  function convMainPath(convId) { return CONVS_DIR + '/' + convId + '/main.json'; }
  function subagentPath(convId, subId) { return CONVS_DIR + '/' + convId + '/subagents/' + subId + '.json'; }
  function taskPath(convId, taskId) { return CONVS_DIR + '/' + convId + '/tasks/' + taskId + '.json'; }
  function archiveSummaryPath(aid) { return ARCHIVES_DIR + '/' + aid + '/archive_summary.json'; }
  function convSummaryPath(aid, cid) { return ARCHIVES_DIR + '/' + aid + '/conv_' + cid + '.json'; }
  function archiveSubagentPath(aid, subId) { return ARCHIVES_DIR + '/' + aid + '/subagents/' + subId + '.json'; }

  // ── 索引管理 ──
  function loadIndex() { return readJson(INDEX_FILE, { conversations: [] }).conversations || []; }
  function saveIndex(entries) { writeJson(INDEX_FILE, { conversations: entries }); }

  function upsertIndex(convId, entry) {
    var entries = loadIndex().filter(function (e) { return e.id !== convId; });
    entries.unshift(entry);
    saveIndex(entries);
  }

  function touchConversation(convId) {
    var entries = loadIndex();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === convId) {
        var e = entries.splice(i, 1)[0];
        entries.unshift(e);
        saveIndex(entries);
        break;
      }
    }
  }

  function removeFromIndex(convId) {
    saveIndex(loadIndex().filter(function (e) { return e.id !== convId; }));
  }

  // ── 对话读写 ──
  function readConv(convId) {
    var c = readJson(convMainPath(convId), null);
    return c && c.id ? c : null;
  }

  function writeConv(conv) { writeJson(convMainPath(conv.id), conv); }

  function deleteConvFile(convId) {
    // 删除 main.json（子代理/任务文件由 JS 层尽力清理）
    N.deleteFile(convMainPath(convId));
  }

  function getConversation(convId) {
    var conv = readConv(convId);
    if (!conv) return null;
    var changed = false;
    (conv.messages || []).forEach(function (m) {
      if (!m.id) { m.id = uid8(); changed = true; }
    });
    if (changed) writeConv(conv);
    return conv;
  }

  function updateConversation(convId, updates) {
    var conv = readConv(convId);
    if (!conv) return;
    for (var k in updates) if (Object.prototype.hasOwnProperty.call(updates, k)) conv[k] = updates[k];
    conv.updated_at = now();
    writeConv(conv);
    upsertIndex(convId, {
      id: conv.id, title: conv.title || '新对话', folder: conv.folder,
      message_count: (conv.messages || []).length,
      created_at: conv.created_at, updated_at: conv.updated_at,
    });
  }

  function deleteConversation(convId) {
    deleteConvFile(convId);
    removeFromIndex(convId);
  }

  // ── 模型配置 ──
  function loadModels() { return readJson(MODELS_FILE, { models: [] }).models || []; }
  function saveModels(models) { writeJson(MODELS_FILE, { models: models }); }

  function getModel(modelId) {
    var ms = loadModels();
    for (var i = 0; i < ms.length; i++) if (ms[i].id === modelId) return ms[i];
    return null;
  }

  function addModel(model) {
    var provider = model.provider || '', modelName = model.model_name || '';
    if (provider && modelName) {
      var ms0 = loadModels();
      for (var i = 0; i < ms0.length; i++)
        if (ms0[i].provider === provider && ms0[i].model_name === modelName) return ms0[i];
    }
    model.id = uid8();
    if (model.reasoning === undefined) model.reasoning = null;
    if (model.thinking_mode === undefined) model.thinking_mode = 'high';
    if (model.permission_mode === undefined) model.permission_mode = 'ask';
    if (model.context_window === undefined) model.context_window = 200000;
    var ms = loadModels();
    ms.push(model);
    saveModels(ms);
    return model;
  }

  function updateModel(modelId, updates) {
    var ms = loadModels();
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].id === modelId) {
        for (var k in updates) if (Object.prototype.hasOwnProperty.call(updates, k)) ms[i][k] = updates[k];
        break;
      }
    }
    saveModels(ms);
  }

  function deleteModel(modelId) {
    saveModels(loadModels().filter(function (m) { return m.id !== modelId; }));
  }

  // ── 应用设置 ──
  function loadSettings() {
    var data = readJson(SETTINGS_FILE, {});
    var defaults = {
      minimal_mode: true,
      knowledge_query_enabled: true,
      self_conv_attach_enabled: false,
      time_inject_enabled: true,
      archive_enabled: true,
    };
    for (var k in defaults) if (data[k] === undefined) data[k] = defaults[k];
    return data;
  }

  function updateSettings(updates) {
    var s = loadSettings();
    for (var k in (updates || {})) if (Object.prototype.hasOwnProperty.call(updates, k)) s[k] = updates[k];
    writeJson(SETTINGS_FILE, s);
    return s;
  }

  // ── 对话管理 ──
  function createConversation(title, folder) {
    title = title || '新对话';
    var conv = {
      id: uid8(), title: title, folder: folder || null,
      messages: [], created_at: now(), updated_at: now(),
    };
    writeConv(conv);
    upsertIndex(conv.id, {
      id: conv.id, title: title, folder: conv.folder, message_count: 0,
      created_at: conv.created_at, updated_at: conv.updated_at,
    });
    return conv;
  }

  function addMessage(convId, role, content, reasoning, promptTokens, reasoningDuration, toolCalls, attachments) {
    var conv = readConv(convId);
    if (!conv) return;
    var msg = { id: uid8(), role: role, content: content };
    if (reasoning) {
      msg.reasoning = reasoning;
      if (reasoningDuration) msg.reasoning_duration = Math.round(reasoningDuration * 10) / 10;
    }
    if (toolCalls !== undefined && toolCalls !== null) msg.tool_calls = toolCalls;
    if (attachments) msg.attachments = attachments;
    conv.messages.push(msg);
    conv.updated_at = now();
    if (promptTokens) conv.prompt_tokens = promptTokens;
    if (role === 'user' && conv.title === '新对话') {
      conv.title = content.slice(0, 20) + (content.length > 20 ? '...' : '');
    }
    writeConv(conv);
    upsertIndex(convId, {
      id: conv.id, title: conv.title, folder: conv.folder,
      message_count: conv.messages.length,
      created_at: conv.created_at, updated_at: conv.updated_at,
    });
  }

  function deleteMessage(convId, msgId) {
    var conv = readConv(convId);
    if (!conv) return;
    conv.messages = conv.messages.filter(function (m) { return m.id !== msgId; });
    conv.updated_at = now();
    writeConv(conv);
    upsertIndex(convId, {
      id: conv.id, title: conv.title, folder: conv.folder,
      message_count: conv.messages.length,
      created_at: conv.created_at, updated_at: conv.updated_at,
    });
  }

  function deleteMessageRound(convId, msgId) {
    var conv = readConv(convId);
    if (!conv) return;
    var msgs = conv.messages;
    var idx = -1;
    for (var i = 0; i < msgs.length; i++) if (msgs[i].id === msgId) { idx = i; break; }
    if (idx < 0) return;
    if (msgs[idx].role === 'user') { deleteMessage(convId, msgId); return; }
    var start = 0;
    for (var j = idx - 1; j >= 0; j--) if (msgs[j].role === 'user') { start = j + 1; break; }
    var end = msgs.length;
    for (var k = idx + 1; k < msgs.length; k++) if (msgs[k].role === 'user') { end = k; break; }
    msgs.splice(start, end - start);
    conv.updated_at = now();
    writeConv(conv);
    upsertIndex(convId, {
      id: conv.id, title: conv.title, folder: conv.folder,
      message_count: msgs.length,
      created_at: conv.created_at, updated_at: conv.updated_at,
    });
  }

  function updateMessage(convId, msgId, updates) {
    var conv = readConv(convId);
    if (!conv) return;
    conv.messages.forEach(function (m) {
      if (m.id === msgId) for (var k in updates) if (Object.prototype.hasOwnProperty.call(updates, k)) m[k] = updates[k];
    });
    conv.updated_at = now();
    writeConv(conv);
  }

  function updateUsageStats(convId, promptTokens, cacheHitTokens) {
    var conv = readConv(convId);
    if (!conv) return { prompt_tokens: 0, cache_stats: {} };
    if (promptTokens) conv.prompt_tokens = promptTokens;
    var stats = conv.cache_stats || { hit_total: 0, prompt_total: 0 };
    stats.hit_total = (stats.hit_total || 0) + (cacheHitTokens || 0);
    stats.prompt_total = (stats.prompt_total || 0) + (promptTokens || 0);
    conv.cache_stats = stats;
    writeConv(conv);
    return { prompt_tokens: conv.prompt_tokens || 0, cache_stats: stats };
  }

  function upsertTaskCard(convId, content) {
    var conv = readConv(convId);
    if (!conv) return;
    conv.messages = conv.messages.filter(function (m) { return m.role !== 'task_card'; });
    conv.messages.push({ id: uid8(), role: 'task_card', content: content });
    conv.updated_at = now();
    writeConv(conv);
    upsertIndex(convId, {
      id: conv.id, title: conv.title, folder: conv.folder,
      message_count: conv.messages.length,
      created_at: conv.created_at, updated_at: conv.updated_at,
    });
  }

  // ── 档案（简化版：保持注册表结构，简述系统保留基础读写） ──
  var DEFAULT_ARCHIVE_ID = 'default';

  function loadArchives() { return readJson(ARCHIVES_FILE, { archives: [] }).archives || []; }
  function saveArchives(archives) { writeJson(ARCHIVES_FILE, { archives: archives }); }

  function getArchive(archiveId) {
    if (archiveId === DEFAULT_ARCHIVE_ID) {
      return { id: DEFAULT_ARCHIVE_ID, name: '默认档案', dir: 'workspace', is_default: true };
    }
    var as = loadArchives();
    for (var i = 0; i < as.length; i++) if (as[i].id === archiveId) return as[i];
    return null;
  }

  function addArchive(name) {
    name = (name || '').trim() || '未命名档案';
    var archives = loadArchives();
    var archiveId = 'archive_' + uid8();
    while (archives.some(function (a) { return a.id === archiveId; })) archiveId = 'archive_' + uid8();
    var archive = {
      id: archiveId, name: name, dir: 'workspace/档案夹/' + archiveId,
      created_at: now(), updated_at: now(),
    };
    archives.push(archive);
    saveArchives(archives);
    return archive;
  }

  function renameArchive(archiveId, newName) {
    if (archiveId === DEFAULT_ARCHIVE_ID) return getArchive(DEFAULT_ARCHIVE_ID);
    var archives = loadArchives();
    for (var i = 0; i < archives.length; i++) {
      if (archives[i].id === archiveId) {
        archives[i].name = (newName || '').trim() || archives[i].name;
        archives[i].updated_at = now();
        saveArchives(archives);
        return archives[i];
      }
    }
    return null;
  }

  function removeArchive(archiveId) {
    var archive = getArchive(archiveId);
    if (!archive || archive.is_default) return 0;
    saveArchives(loadArchives().filter(function (a) { return a.id !== archiveId; }));
    // 删除该档案下全部对话
    var removed = 0;
    loadIndex().forEach(function (entry) {
      if (entry.folder && entry.folder.indexOf(archive.dir) === 0) {
        deleteConversation(entry.id);
        removed++;
      }
    });
    return removed;
  }

  // ── 子代理 ──
  function createSubagent(convId, subId, task) {
    var sub = {
      id: subId, conv_id: convId, task: task, status: 'running',
      messages: [], created_at: now(), finished_at: null, output: '', error: null,
    };
    writeJson(subagentPath(convId, subId), sub);
    return sub;
  }

  function getSubagent(convId, subId) { return readJson(subagentPath(convId, subId), null); }

  function updateSubagent(convId, subId, updates) {
    var sub = getSubagent(convId, subId);
    if (!sub) return;
    for (var k in updates) if (Object.prototype.hasOwnProperty.call(updates, k)) sub[k] = updates[k];
    writeJson(subagentPath(convId, subId), sub);
  }

  function addSubagentMessage(convId, subId, role, content, reasoning, reasoningDuration, toolCalls) {
    var sub = getSubagent(convId, subId);
    if (!sub) return;
    var msg = { id: uid8(), role: role, content: content };
    if (reasoning) msg.reasoning = reasoning;
    if (toolCalls !== undefined && toolCalls !== null) msg.tool_calls = toolCalls;
    sub.messages.push(msg);
    writeJson(subagentPath(convId, subId), sub);
  }

  function listSubagents(convId) {
    // 尽力列出：目录结构不可直接枚举时返回 []
    var out = [];
    try {
      var dir = CONVS_DIR + '/' + convId + '/subagents';
      var names = JSON.parse(N.listDir(dir) || '[]');
      names.forEach(function (n) {
        if (n.endsWith('.json')) {
          var d = readJson(dir + '/' + n, null);
          if (d) out.push(d);
        }
      });
    } catch (e) { /* ignore */ }
    return out.sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); });
  }

  // ── 任务清单 ──
  function listTasks(convId) {
    var out = [];
    try {
      var dir = CONVS_DIR + '/' + convId + '/tasks';
      var names = JSON.parse(N.listDir(dir) || '[]');
      names.sort();
      names.forEach(function (n) {
        if (n.startsWith('task_') && n.endsWith('.json')) {
          var d = readJson(dir + '/' + n, null);
          if (d) out.push(d);
        }
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function getTask(convId, taskId) { return readJson(taskPath(convId, taskId), null); }

  function createTask(convId, source, steps) {
    var seq = listTasks(convId).length + 1;
    var task = {
      id: 'task_' + seq, seq: seq, status: '未完成', source: source,
      steps: steps || [], context_anchor_msg_id: null,
      created_at: now(), finished_at: null,
    };
    writeJson(taskPath(convId, task.id), task);
    return task;
  }

  function updateTask(convId, taskId, updates) {
    var task = getTask(convId, taskId);
    if (!task) return null;
    for (var k in updates) if (Object.prototype.hasOwnProperty.call(updates, k)) task[k] = updates[k];
    writeJson(taskPath(convId, taskId), task);
    return task;
  }

  // ── 档案简述（基础读写） ──
  function loadArchiveSummary(archiveId) {
    var d = readJson(archiveSummaryPath(archiveId), null);
    if (!d) return null;
    if (!d.summary && d.content) { d.summary = d.content; d.convs = d.convs || {}; }
    return d;
  }

  function saveArchiveSummary(archiveId, summary, convs, updatedAt, covered) {
    var existing = loadArchiveSummary(archiveId) || {};
    var data = {
      archive_id: archiveId,
      summary: summary || '',
      convs: convs !== undefined ? convs : (existing.convs || {}),
      updated_at: updatedAt !== undefined ? updatedAt : now(),
    };
    if (covered !== undefined) data.covered = covered;
    else if (existing.covered !== undefined) data.covered = existing.covered;
    writeJson(archiveSummaryPath(archiveId), data);
    return data;
  }

  function loadConvSummary(archiveId, convId) { return readJson(convSummaryPath(archiveId, convId), null); }

  function saveConvSummary(archiveId, convId, content, updatedAt, lastSeen, lastMsgId) {
    var existing = loadConvSummary(archiveId, convId) || {};
    var data = {
      conv_id: convId, archive_id: archiveId, content: content,
      updated_at: updatedAt !== undefined ? updatedAt : now(),
    };
    if (lastSeen !== undefined) data.last_seen = lastSeen;
    else if (existing.last_seen !== undefined) data.last_seen = existing.last_seen;
    if (lastMsgId !== undefined) data.last_msg_id = lastMsgId;
    else if (existing.last_msg_id !== undefined) data.last_msg_id = existing.last_msg_id;
    writeJson(convSummaryPath(archiveId, convId), data);
    return data;
  }

  function deleteConvSummary(archiveId, convId) { N.deleteFile(convSummaryPath(archiveId, convId)); }

  // ── 知识库用户扩展目录（移动端：只读 assets，写操作忽略） ──
  var KB_USER = 'knowledge';

  var api = {
    uid8: uid8, now: now,
    loadModels: loadModels, saveModels: saveModels, getModel: getModel,
    addModel: addModel, updateModel: updateModel, deleteModel: deleteModel,
    loadSettings: loadSettings, updateSettings: updateSettings,
    loadConversations: loadIndex, saveConversations: saveIndex,
    createConversation: createConversation, getConversation: getConversation,
    updateConversation: updateConversation, deleteConversation: deleteConversation,
    addMessage: addMessage, deleteMessage: deleteMessage, deleteMessageRound: deleteMessageRound,
    updateMessage: updateMessage, updateUsageStats: updateUsageStats,
    upsertTaskCard: upsertTaskCard, touchConversation: touchConversation,
    loadArchives: loadArchives, saveArchives: saveArchives, getArchive: getArchive,
    addArchive: addArchive, renameArchive: renameArchive, removeArchive: removeArchive,
    createSubagent: createSubagent, getSubagent: getSubagent, updateSubagent: updateSubagent,
    addSubagentMessage: addSubagentMessage, listSubagents: listSubagents,
    listTasks: listTasks, getTask: getTask, createTask: createTask, updateTask: updateTask,
    loadArchiveSummary: loadArchiveSummary, saveArchiveSummary: saveArchiveSummary,
    loadConvSummary: loadConvSummary, saveConvSummary: saveConvSummary,
    deleteConvSummary: deleteConvSummary,
    KB_USER: KB_USER, DEFAULT_ARCHIVE_ID: DEFAULT_ARCHIVE_ID,
    DATA_DIR: DATA_DIR,
  };

  global.PusuanStorage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
