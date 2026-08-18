/**
 * 普算移动端 · 厂商注册中心
 * 对应桌面版 backend/provider.py + providers/<id>/adapter.py。
 * 移动端内置三厂商（deepseek / sensenova / tokenrhythm），
 * 协议均为 OpenAI 兼容 chat completions，推理内容字段 reasoning_content。
 * API Key 存应用私有数据目录 credentials.json（不随 APK 分发）。
 */
(function (global) {
  'use strict';

  var N = global.PusuanNative;

  // ── 厂商元数据（对应 providers/<id>/provider.json） ──
  var PROVIDERS = {
    deepseek: {
      id: 'deepseek', name: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      chat_endpoint: '/v1/chat/completions',
      models_endpoint: '/models',
      protocol: 'openai_chat',
      supports_reasoning: true,
      supports_cache_stats: true,
      reasoning_efforts: ['low', 'high', 'xhigh', 'max'],
      min_reasoning_effort: 'low',
      default_reasoning_effort: 'high',
      thinking_param: { type: 'enabled' },
      reasoning_policy: { tool_call_must_echo_reasoning: true },
      error_map: {
        '400': '请求体格式错误（400）：请根据错误信息提示修改请求体',
        '401': 'API Key 认证失败（401）：请检查 API Key 是否正确',
        '402': '账号余额不足（402）：请前往充值页面充值',
        '422': '请求体参数错误（422）：请根据错误信息提示修改相关参数',
        '429': '请求速率达到上限（429）：请合理规划请求速率',
        '500': '服务器内部故障（500）：请稍后重试',
        '502': '网关错误（502）：请稍后重试',
        '503': '服务器繁忙（503）：请稍后重试',
        '504': '网关超时（504）：请稍后重试',
      },
      supports_temperature: true,
      context_window_default: 200000,
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    sensenova: {
      id: 'sensenova', name: '商汤日日新',
      base_url: 'https://api.sensenova.cn',
      chat_endpoint: '/v1/chat/completions',
      models_endpoint: '/models',
      protocol: 'openai_chat',
      supports_reasoning: false,
      supports_cache_stats: false,
      thinking_param: { type: 'none' },
      error_map: {
        '400': '请求体格式错误（400）：请根据错误信息提示修改请求体',
        '401': 'API Key 认证失败（401）：请检查 API Key 是否正确',
        '429': '请求速率达到上限（429）：请合理规划请求速率',
      },
      supports_temperature: true,
      context_window_default: 131072,
      models: ['SenseChat-5', 'SenseChat-Turbo'],
    },
    tokenrhythm: {
      id: 'tokenrhythm', name: 'TokenRhythm',
      base_url: 'https://api.tokenrhythm.com',
      chat_endpoint: '/v1/chat/completions',
      models_endpoint: '/models',
      protocol: 'openai_chat',
      supports_reasoning: false,
      supports_cache_stats: false,
      thinking_param: { type: 'none' },
      error_map: {
        '400': '请求体格式错误（400）：请根据错误信息提示修改请求体',
        '401': 'API Key 认证失败（401）：请检查 API Key 是否正确',
        '429': '请求速率达到上限（429）：请合理规划请求速率',
      },
      supports_temperature: true,
      context_window_default: 131072,
      models: ['token-rhythm-v1'],
    },
  };

  function credentialsFile() { return 'credentials.json'; }

  function loadCredentials() {
    var raw = N.readFile(credentialsFile());
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  function saveCredentials(c) { N.writeFile(credentialsFile(), JSON.stringify(c, null, 2)); }

  function getApiKey(providerId) {
    var c = loadCredentials();
    return c[providerId] || '';
  }

  function setApiKey(providerId, key) {
    var c = loadCredentials();
    if (!key) { delete c[providerId]; }
    else { c[providerId] = key; }
    saveCredentials(c);
  }

  function getProvider(providerId) { return PROVIDERS[providerId] || null; }

  function listProviders() {
    return Object.keys(PROVIDERS).map(function (id) { return PROVIDERS[id]; });
  }

  /** 列出厂商官方模型（静态内置；fetch_provider_models 亦可动态拉取） */
  function listProviderModels(providerId) {
    var p = PROVIDERS[providerId];
    return p ? (p.models || []) : [];
  }

  /** 动态拉取厂商模型列表（/v1/models），失败返回 null（调用方回退静态列表） */
  function fetchProviderModels(providerId) {
    var p = PROVIDERS[providerId];
    if (!p) return Promise.resolve(null);
    var key = getApiKey(providerId);
    if (!key) return Promise.resolve(null);
    var url = p.base_url.replace(/\/$/, '') + p.models_endpoint;
    return fetch(url, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (j) {
        var list = (j.data || []).map(function (m) { return m.id; });
        return list.length ? list : null;
      });
    }).catch(function () { return null; });
  }

  // ── 适配器：消息组装（对应 deepseek/adapter.py 的 build_messages） ──
  // 规则：
  //   1. 带 tool_calls 的 assistant 消息：reasoning_content 必须原样回传
  //   2. 不带 tool_calls 的 assistant 消息：不回传 reasoning_content
  //   3. error 消息转 user 并标注程序注入
  function buildMessages(conv, systemPrompt, providerCfg) {
    var messages = [{ role: 'system', content: systemPrompt }];
    var history = conv && conv.messages ? conv.messages : [];
    history.forEach(function (h) {
      var role = h.role;
      if (role === 'tool') {
        try {
          var data = JSON.parse(h.content);
          messages.push({
            role: 'tool', tool_call_id: data.tool_call_id || 'unknown',
            content: data.result !== undefined ? data.result : h.content,
          });
        } catch (e) { /* skip broken tool msg */ }
      } else if (role === 'assistant') {
        if (h.tool_calls && h.tool_calls.length) {
          // 工具调用消息：content 可 null + tool_calls + 必须回传 reasoning_content（DeepSeek 强制）
          messages.push({
            role: 'assistant',
            content: h.content || null,
            tool_calls: h.tool_calls,
            reasoning_content: h.reasoning || '',
          });
        } else {
          // 最终回答：只回传正文（不拼 reasoning_content）；正文为空则跳过（避免 content/tool_calls 双空 400）
          if (h.content) {
            messages.push({ role: 'assistant', content: h.content });
          }
        }
      } else if (role === 'interactive' || role === 'task_card') {
        // 仅前端展示，不进模型上下文
      } else if (role === 'error') {
        try {
          var e = JSON.parse(h.content);
          messages.push({
            role: 'user',
            content: '【程序注入·上一条回复出错】' + (e.message || '未知错误') +
                     '（错误码 ' + (e.code === null || e.code === undefined ? '未知' : e.code) + '）。' +
                     '请向用户如实说明刚才发生的问题，并基于现有信息继续完成用户的任务。',
          });
        } catch (e2) {
          messages.push({ role: 'user', content: '【程序注入·上一条回复出错】' + h.content });
        }
      } else {
        messages.push({ role: role, content: h.content });
      }
    });
    return messages;
  }

  /** 组装请求体（对应 adapter.build_payload） */
  function buildPayload(modelCfg, messages, thinkingMode, toolsList, providerCfg) {
    var payload = {
      model: modelCfg.model_name || '',
      messages: messages,
      stream: true,
      tools: toolsList,
      tool_choice: 'auto',
    };
    if (providerCfg.supports_temperature !== false) payload.temperature = 0.7;
    if (thinkingMode && providerCfg.thinking_param && providerCfg.thinking_param.type === 'enabled') {
      payload.thinking = { type: 'enabled', effort: thinkingMode };
    }
    return payload;
  }

  function mapError(statusCode, body, providerCfg) {
    var em = providerCfg && providerCfg.error_map;
    if (em && em[String(statusCode)]) return em[String(statusCode)];
    return 'API 错误 (' + statusCode + '): ' + (body || '').slice(0, 300);
  }

  var api = {
    PROVIDERS: PROVIDERS,
    getProvider: getProvider, listProviders: listProviders,
    getApiKey: getApiKey, setApiKey: setApiKey,
    listProviderModels: listProviderModels, fetchProviderModels: fetchProviderModels,
    buildMessages: buildMessages, buildPayload: buildPayload, mapError: mapError,
  };

  global.PusuanProvider = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
