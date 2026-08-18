/**
 * 普算移动端 · API 桥接层
 * 前端 index.html 通过 window.pywebview.api.xxx() 调用后端（返回 JSON 字符串），
 * 本文件在页面加载前注入，实现完整的 pywebview.api 接口 —— 前端代码零修改运行。
 * 所有返回格式与桌面版 backend/api.py 完全一致。
 */
(function (global) {
  'use strict';

  var S = global.PusuanStorage;
  var P = global.PusuanProvider;
  var T = global.PusuanTools;
  var C = global.PusuanChat;
  var N = global.PusuanNative;

  // ── 活动流：conv_id -> {aborted, signal, controller} ──
  var streams = {};

  // ── 工具确认等待 ──
  var toolConfirmEvents = {};   // conv_id -> {resolve}
  var askEvents = {};           // conv_id -> {resolve}

  function jsonOk(data) { return JSON.stringify(data); }

  function formatAnswers(data) {
    var questions = data.questions || [];
    var answers = data.answers || {};
    var lines = ['【用户回答】'];
    questions.forEach(function (q, i) {
      var key = String(i + 1);
      var a = String(answers[key] !== undefined ? answers[key] : (answers[i + 1] !== undefined ? answers[i + 1] : '')).trim();
      if (!a) a = '用户未回答，请自行推断。';
      lines.push('问题' + (i + 1) + '：' + q + '\n回答：' + a);
    });
    return lines.join('\n');
  }

  // ── 启动流式对话任务（send_message 与 submit_interactive 重启共用） ──
  function startStreamTask(convId, model, userMessage, persistUser, attachment) {
    S.touchConversation(convId);
    var st = { aborted: false, controller: null };
    streams[convId] = st;
    C.streamChat({
      convId: convId,
      userMessage: userMessage,
      modelConfig: model,
      attachment: attachment || '',
      thinkingMode: model.thinking_mode || 'high',
      permissionMode: model.permission_mode || 'ask',
      cancelEvent: st,
      persistUser: persistUser !== false,
      onStreamReady: function (getCtrl) {
        st.getController = getCtrl;
      },
      onChunk: function (token) {
        pushJs('window.Pusuan && Pusuan.onChunk && Pusuan.onChunk(' +
          JSON.stringify(convId) + ',' + JSON.stringify(token) + ');');
      },
      onReasoning: function (token) {
        pushJs('window.Pusuan && Pusuan.onReasoning && Pusuan.onReasoning(' +
          JSON.stringify(convId) + ',' + JSON.stringify(token) + ');');
      },
      onToolCallStart: function (name, index) {
        pushJs('window.Pusuan && Pusuan.onToolCallStart && Pusuan.onToolCallStart(' +
          JSON.stringify(convId) + ',' + JSON.stringify(name) + ',' + index + ');');
      },
      onToolCall: function (name, argsJson, index) {
        pushJs('window.Pusuan && Pusuan.onToolCall && Pusuan.onToolCall(' +
          JSON.stringify(convId) + ',' + JSON.stringify(name) + ',' + JSON.stringify(argsJson) + ',' + index + ');');
      },
      onToolResult: function (name, result, index) {
        pushJs('window.Pusuan && Pusuan.onToolResult && Pusuan.onToolResult(' +
          JSON.stringify(convId) + ',' + JSON.stringify(name) + ',' + JSON.stringify(result) + ',' + index + ');');
      },
      onSubagentDone: function (index, ok) {
        pushJs('window.Pusuan && Pusuan.onSubagentDone && Pusuan.onSubagentDone(' +
          JSON.stringify(convId) + ',' + index + ',' + (ok ? 'true' : 'false') + ');');
      },
      onApiError: function (code, message, msgId) {
        pushJs('window.Pusuan && Pusuan.onApiError && Pusuan.onApiError(' +
          JSON.stringify(convId) + ',' + JSON.stringify(code) + ',' + JSON.stringify(message) + ',' + JSON.stringify(msgId) + ');');
      },
      onUsage: function (promptTokens, cacheStats) {
        pushJs('window.Pusuan && Pusuan.onUsage && Pusuan.onUsage(' +
          JSON.stringify(convId) + ',' + JSON.stringify({ pt: promptTokens, stats: cacheStats }) + ');');
      },
      onTaskCard: function (card) {
        pushJs('window.Pusuan && Pusuan.onTaskCard && Pusuan.onTaskCard(' +
          JSON.stringify(convId) + ',' + JSON.stringify(card) + ');');
      },
      onDone: function () {
        console.log('[DoneTrace] bridge onDone fired');
        pushJs('window.Pusuan && Pusuan.onDone && Pusuan.onDone(' +
          JSON.stringify(convId) + ');');
      },
      onLog: function (level, category, message, data) {
        if (level === 'error') console.error('[Pusuan]', category, message, data);
        else console.log('[Pusuan]', category, message, data);
      },
      confirmTool: function (convId2, toolName, toolArgs) {
        return new Promise(function (resolve) {
          toolConfirmEvents[convId2] = { resolve: resolve };
          pushJs('window.Pusuan && Pusuan.onToolConfirm && Pusuan.onToolConfirm(' +
            JSON.stringify(convId2) + ',' + JSON.stringify(toolName) + ',' + JSON.stringify(toolArgs) + ');');
          setTimeout(function () {
            if (toolConfirmEvents[convId2]) {
              toolConfirmEvents[convId2].resolve(false);
              delete toolConfirmEvents[convId2];
            }
          }, 60000);
        });
      },
      askUser: function (convId2, toolArgs) {
        return new Promise(function (resolve) {
          var questions = (toolArgs.questions || []).map(function (q) { return String(q).trim(); }).filter(Boolean).slice(0, 5);
          if (!questions.length) { resolve('错误: ask 需要 questions 参数（问题列表）。'); return; }
          S.addMessage(convId2, 'interactive', JSON.stringify({ questions: questions, status: 'pending', answers: {} }));
          var conv = S.getConversation(convId2);
          var msgId = conv && conv.messages && conv.messages.length
            ? conv.messages[conv.messages.length - 1].id : '';
          askEvents[convId2] = { resolve: resolve, msgId: msgId };
          pushJs('window.Pusuan && Pusuan.onInteractiveCard && Pusuan.onInteractiveCard(' +
            JSON.stringify(convId2) + ',' + JSON.stringify(msgId) + ',' + JSON.stringify(questions) + ');');
        });
      },
    });
  }

  var api = {
    // ══════════ 模型管理 ══════════
    get_models: function () {
      var models = S.loadModels();
      var changed = false;
      models.forEach(function (m) {
        if (!m.provider) { m.provider = 'deepseek'; m.base_url = 'https://api.deepseek.com'; changed = true; }
        delete m.api_key;
      });
      if (changed) S.saveModels(models);
      return jsonOk(models);
    },
    add_model: function (providerId, modelName, contextWindow) {
      var m = S.addModel({
        provider: providerId, model_name: modelName,
        context_window: contextWindow || 200000,
      });
      return jsonOk({ ok: true, model: m });
    },
    delete_model: function (modelId) {
      S.deleteModel(modelId);
      return jsonOk({ ok: true });
    },
    update_model: function (modelId, contextWindow, thinkingMode, permissionMode, reasoning) {
      var updates = {};
      if (contextWindow !== undefined && contextWindow !== null) updates.context_window = contextWindow;
      if (thinkingMode !== undefined && thinkingMode !== null) updates.thinking_mode = thinkingMode;
      if (permissionMode !== undefined && permissionMode !== null) updates.permission_mode = permissionMode;
      if (reasoning !== undefined && reasoning !== null) updates.reasoning = reasoning;
      S.updateModel(modelId, updates);
      return jsonOk({ ok: true });
    },
    set_thinking_mode: function (modelId, mode) {
      S.updateModel(modelId, { thinking_mode: mode });
      return jsonOk({ ok: true });
    },
    set_permission_mode: function (modelId, mode) {
      S.updateModel(modelId, { permission_mode: mode });
      return jsonOk({ ok: true });
    },
    get_providers: function () {
      var providers = P.listProviders();
      var models = S.loadModels();
      var result = providers.map(function (cfg) {
        var pid = cfg.id;
        return {
          id: pid, name: cfg.name, base_url: cfg.base_url || '',
          reasoning_efforts: cfg.reasoning_efforts || [],
          default_reasoning_effort: cfg.default_reasoning_effort || 'high',
          supports_reasoning: !!cfg.supports_reasoning,
          supports_cache_stats: !!cfg.supports_cache_stats,
          context_window_default: cfg.context_window_default || 200000,
          has_key: !!P.getApiKey(pid),
          api_key: P.getApiKey(pid),
          models: models.filter(function (m) { return m.provider === pid; })
            .map(function (m) { return { id: m.id, model_name: m.model_name, reasoning: m.reasoning }; }),
        };
      });
      return jsonOk(result);
    },
    save_provider_key: function (providerId, apiKey) {
      P.setApiKey(providerId, apiKey);
      return jsonOk({ ok: true });
    },
    fetch_provider_models: function (providerId) {
      var cfg = P.getProvider(providerId);
      if (!cfg) return Promise.resolve(jsonOk({ error: '未知厂商: ' + providerId }));
      var key = P.getApiKey(providerId);
      if (!key) return Promise.resolve(jsonOk({ error: '请先在厂商区域填写 API Key' }));
      var url = cfg.base_url.replace(/\/$/, '') + (cfg.models_endpoint || '/models');
      return fetch(url, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) })
        .then(function (resp) {
          if (!resp.ok) return resp.text().then(function (b) { return jsonOk({ error: P.mapError(resp.status, b, cfg) }); });
          return resp.json().then(function (data) {
            var modelIds = (data.data || []).map(function (m) { return m.id; }).filter(Boolean);
            if (!modelIds.length) return jsonOk({ error: '该厂商未返回任何模型' });
            var created = modelIds.map(function (mid) {
              return S.addModel({
                name: cfg.name, provider: providerId, base_url: cfg.base_url,
                model_name: mid, context_window: cfg.context_window_default || 200000,
              });
            });
            return jsonOk({ ok: true, models: created });
          });
        })
        .catch(function (e) { return jsonOk({ error: '请求失败: ' + e.message }); });
    },
    get_tools: function () {
      var allTools = T.buildTools();
      var names = ['read', 'write', 'bash', 'spawn_subagent', 'task', 'ask', 'knowledge_query', 'conversation_query', 'liuren_paipan', 'liuyao_qigua'];
      var baseTools = names.map(function (n) {
        var t = allTools.filter(function (x) { return x.function.name === n; })[0];
        return { name: n, description: t ? t.function.description : '' };
      });
      var skills = T.scanSkills().map(function (sk) {
        return { name: sk.name, description: sk.description, dir: sk.dir };
      });
      return jsonOk({ base_tools: baseTools, skills: skills });
    },
    get_settings: function () {
      return jsonOk(S.loadSettings());
    },
    update_settings: function (updatesJson) {
      var updates = {};
      try { updates = JSON.parse(updatesJson); } catch (e) {}
      return jsonOk(S.updateSettings(updates));
    },
    confirm_tool: function (convId, approved) {
      if (toolConfirmEvents[convId]) {
        toolConfirmEvents[convId].resolve(!!approved);
        delete toolConfirmEvents[convId];
      }
      return jsonOk({ ok: true });
    },
    detect_all_reasoning: function () {
      S.loadModels().forEach(function (m) { S.updateModel(m.id, { reasoning: true }); });
      return jsonOk({ ok: true });
    },

    // ══════════ 对话管理 ══════════
    get_conversations: function () {
      return jsonOk(S.loadConversations());
    },
    get_conversation_info: function (convId) {
      var conv = S.getConversation(convId);
      if (!conv) return jsonOk({});
      return jsonOk({
        id: conv.id, title: conv.title,
        message_count: (conv.messages || []).length,
        prompt_tokens: conv.prompt_tokens || 0,
        cache_stats: conv.cache_stats || {},
      });
    },
    create_conversation: function (folder) {
      var conv = S.createConversation('新对话', folder || null);
      return jsonOk({ id: conv.id, title: conv.title, folder: conv.folder });
    },
    delete_conversation: function (convId) {
      S.deleteConversation(convId);
      delete streams[convId];
      return jsonOk({ ok: true });
    },
    rename_conversation: function (convId, newTitle) {
      S.updateConversation(convId, { title: newTitle || '新对话' });
      return jsonOk({ ok: true });
    },
    delete_message: function (convId, msgId) {
      S.deleteMessage(convId, msgId);
      return jsonOk({ ok: true });
    },
    delete_message_round: function (convId, msgId) {
      S.deleteMessageRound(convId, msgId);
      return jsonOk({ ok: true });
    },
    branch_conversation: function (convId, msgId) {
      var conv = S.getConversation(convId);
      if (!conv) return jsonOk({ error: '对话不存在' });
      var idx = -1;
      conv.messages.forEach(function (m, i) { if (m.id === msgId) idx = i; });
      if (idx < 0) return jsonOk({ error: '消息不存在' });
      var branchMsgs = JSON.parse(JSON.stringify(conv.messages.slice(0, idx + 1)));
      var newConv = S.createConversation(conv.title || '新对话', conv.folder);
      newConv.messages = branchMsgs;
      newConv.prompt_tokens = conv.prompt_tokens || 0;
      newConv.cache_stats = JSON.parse(JSON.stringify(conv.cache_stats || {}));
      newConv.updated_at = S.now();
      N.writeFile('convs/' + newConv.id + '/main.json', JSON.stringify(newConv, null, 2));
      var convs = S.loadConversations();
      convs.forEach(function (e) {
        if (e.id === newConv.id) {
          e.message_count = branchMsgs.length;
          e.title = newConv.title;
          e.updated_at = newConv.updated_at;
        }
      });
      S.saveConversations(convs);
      return jsonOk({ id: newConv.id, folder: newConv.folder });
    },
    confirm_error: function (convId, msgId) {
      S.updateMessage(convId, msgId, { confirmed: true });
      return jsonOk({ ok: true });
    },
    get_messages: function (convId) {
      var conv = S.getConversation(convId);
      return jsonOk(conv ? conv.messages : []);
    },
    open_file_dialog: function () {
      try { N.toast("移动端暂不支持选择文件，请直接粘贴文本或使用对话附件"); } catch (e) {}
      return jsonOk([]); // 移动端暂不支持文件选择
    },

    // ══════════ 权限管理 ══════════
    check_storage_permission: function () {
      try { return !!N.checkStoragePermission(); } catch (e) { return false; }
    },
    request_storage_permission: function () {
      try { N.requestStoragePermission(); } catch (e) {}
      return jsonOk({ ok: true });
    },

    // ══════════ 档案 ══════════
    get_archives: function () {
      var result = [{
        id: 'default', name: '默认档案',
        path: 'workspace', is_default: true, has_summary: false,
      }];
      S.loadArchives().forEach(function (a) {
        var asum = S.loadArchiveSummary(a.id);
        result.push({
          id: a.id, name: a.name || '未命名档案',
          path: a.dir, is_default: false,
          has_summary: !!(asum && asum.summary),
        });
      });
      return jsonOk(result);
    },
    create_archive: function (name) {
      var a = S.addArchive(name || '');
      return jsonOk({ id: a.id, name: a.name, path: a.dir, is_default: false });
    },
    rename_archive: function (archiveId, name) {
      var a = S.renameArchive(archiveId, name || '');
      if (!a) return jsonOk({ error: '档案不存在' });
      return jsonOk({ id: a.id, name: a.name });
    },
    delete_archive: function (archiveId) {
      if (archiveId === 'default') return jsonOk({ ok: false, error: '默认档案不可删除' });
      var removed = S.removeArchive(archiveId);
      return jsonOk({ ok: true, removed: removed });
    },
    get_archive_detail: function (archiveId) {
      var archive = S.getArchive(archiveId);
      if (!archive) return jsonOk({});
      var isDefault = archive.is_default || archiveId === 'default';
      var archDir = archive.dir || '';
      var convs = S.loadConversations().filter(function (c) {
        if (isDefault) return !c.folder;
        return c.folder && c.folder.indexOf(archDir) === 0;
      }).map(function (c) {
        var cs = S.loadConvSummary(archiveId, c.id);
        return {
          id: c.id, title: c.title, message_count: c.message_count || 0,
          summary: (cs && cs.content) || '',
          summary_updated_at: cs ? cs.updated_at : undefined,
        };
      });
      var asum = S.loadArchiveSummary(archiveId);
      return jsonOk({
        id: archive.id, name: archive.name, is_default: isDefault,
        summary: (asum && asum.summary) || '',
        summary_updated_at: asum ? asum.updated_at : undefined,
        regions: (asum && asum.convs) || {},
        convs: convs,
      });
    },

    // ══════════ 对话流 ══════════
    send_message: function (convId, message, modelId, attachment) {
      var model = S.getModel(modelId);
      if (!model) return jsonOk({ error: '请先配置模型' });
      startStreamTask(convId, model, message, true, attachment || '');
      return jsonOk({ ok: true });
    },
    cancel_stream: function (convId) {
      if (streams[convId]) {
        streams[convId].aborted = true;
        try {
          var ctrl = streams[convId].getController ? streams[convId].getController() : null;
          if (ctrl && ctrl.abort) ctrl.abort();
        } catch (e) {}
        if (streams[convId].controller) streams[convId].controller.abort();
        if (askEvents[convId]) {
          askEvents[convId].resolve('ask 已被用户暂停。');
          delete askEvents[convId];
        }
      }
      return jsonOk({ ok: true });
    },
    submit_interactive: function (convId, msgId, answers, modelId) {
      var conv = S.getConversation(convId);
      if (!conv) return jsonOk({ ok: false, error: '对话不存在' });
      var data = null;
      conv.messages.forEach(function (m) {
        if (m.id === msgId && m.role === 'interactive') {
          try { data = JSON.parse(m.content); } catch (e) { data = {}; }
        }
      });
      if (data === null) return jsonOk({ ok: false, error: '卡片不存在' });
      var answersObj = {};
      try {
        if (typeof answers === 'string') answersObj = JSON.parse(answers);
        else answersObj = answers || {};
      } catch (e) { answersObj = {}; }
      data.status = 'submitted';
      data.answers = answersObj;
      S.updateMessage(convId, msgId, { content: JSON.stringify(data) });

      var ev = askEvents[convId];
      if (ev) {
        ev.resolve(formatAnswers(data));
        delete askEvents[convId];
        return jsonOk({ ok: true, restarted: false });
      }
      var model = modelId ? S.getModel(modelId) : null;
      if (!model) return jsonOk({ ok: false, error: '请先配置模型' });
      startStreamTask(convId, model, formatAnswers(data), false);
      return jsonOk({ ok: true, restarted: true });
    },

    // ══════════ 窗口控制（移动端 no-op） ══════════
    minimize_window: function () { return jsonOk({ ok: true }); },
    maximize_window: function () { return jsonOk({ ok: true }); },
    restore_window: function () { return jsonOk({ ok: true }); },
    close_window: function () { return jsonOk({ ok: true }); },
    restart_app: function () { return jsonOk({ ok: true }); },
    get_window_rect: function () {
      return jsonOk({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    },
    set_window_rect: function () { return jsonOk({ ok: true }); },
  };

  // 向后端推送 JS（桥接层直接调用前端注册的 UI 回调）
  function pushJs(code) {
    try {
      console.log("[PusuanBridge] push:", code.slice(0, 80));
      setTimeout(function () {
        try { (0, eval)(code); } catch (e) { console.error("[PusuanBridge] eval失败:", e.message, code.slice(0, 80)); }
      }, 0);
    } catch (e) {}
  }

  // 安装 window.pywebview.api
  if (!global.pywebview) global.pywebview = {};
  global.pywebview.api = api;

  // 版本信息
  global.PusuanVersion = {
    version: (function () {
      try { return N.getVersion(); } catch (e) { return '1.0.0'; }
    })(),
    platform: 'android',
  };

  // 就绪事件（模拟 pywebview 的 pywebviewready）
  setTimeout(function () {
    try {
      global.dispatchEvent(new Event('pywebviewready'));
    } catch (e) {}
  }, 50);

})(typeof window !== 'undefined' ? window : globalThis);
