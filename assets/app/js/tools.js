/**
 * 普算移动端 · 工具系统
 * 对应桌面版 backend/tools.py + backend/kb.py。
 * 移动端环境限制：
 *  - bash 工具不可用（Android 无 shell）→ 返回明确错误
 *  - read/write 作用于应用私有数据目录下的 workspace/（沙箱路径）
 *  - 排盘引擎（六壬 lrpp.js / 六爻 JS 移植版）在 WebView 内直接运行
 */
(function (global) {
  'use strict';

  var S = global.PusuanStorage;
  var N = global.PusuanNative;

  var MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB（移动端限制更小）
  var readCache = {};

  // ══════════════════════════════════════════
  // 工具 schema（对应 tools.py TOOLS）
  // ══════════════════════════════════════════

  var READ_TOOL = {
    type: 'function',
    function: {
      name: 'read',
      description: '读取文件全部内容或列出目录。传入文件路径时，返回带行号的完整内容（cat -n 格式），超过 5MB 截断。传入目录路径时，返回目录下的文件和子目录列表。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件或目录的绝对路径（虚拟路径，如 /workspace/xxx）' } },
        required: ['path'],
      },
    },
  };

  var WRITE_TOOL = {
    type: 'function',
    function: {
      name: 'write',
      description: '写入文件内容。如果文件已存在，必须先调用 read 读取文件内容后再修改。如果是新建文件（文件不存在），无需先读取，可以直接写入。会自动创建不存在的父目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径（虚拟路径，如 /workspace/xxx）' },
          content: { type: 'string', description: '要写入文件的完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  };

  var BASH_TOOL = {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 shell 命令并返回输出。注意：移动端不支持 shell 命令，此工具不可用。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          description: { type: 'string', description: '命令功能简述' },
        },
        required: ['command', 'description'],
      },
    },
  };

  var SPAWN_SUBAGENT_TOOL = {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: '分发一个子代理执行独立任务。子代理拥有独立的上下文窗口，不受主对话历史污染，只接收你下发的任务描述，使用当前模型独立完成（可 read 查阅文件、加载技能）。你可以在一轮内发出多个 spawn_subagent 调用并行运行多个子代理。所有子代理执行完毕后，你将收到每个子代理的完整上下文与最终结果，据此继续作答。子代理无法与用户直接对话，一切交互与交接由你负责；子代理无权再分发子代理。',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: '下发给子代理的完整任务描述' } },
        required: ['task'],
      },
    },
  };

  var TASK_TOOL = {
    type: 'function',
    function: {
      name: 'task',
      description: '任务清单工具。把用户指令或技能流程拆解为可执行的结构化任务清单，以步为单位逐步执行，每步完成后经子代理验证才允许推进下一步。触发时机：1) 用户输入了明确的任务清单、结构化或分步骤的任务内容时，立即调用本工具创建任务清单（source=user）；2) 调用 skill_select 阅读技能后，若技能内含流程步骤/执行流程，必须紧接着调用本工具创建任务清单（source=skill）。执行纪律：严格按清单顺序逐步执行——开始执行某步前调用 task(start)，该步全部工作完成后调用 task(complete) 交卷；未完成当前步骤前不得进行下一步。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'start', 'complete', 'abandon'], description: 'create=创建任务清单；start=开始执行当前步骤；complete=完成当前步骤；abandon=废弃' },
          source: { type: 'string', enum: ['user', 'skill'], description: '仅 create 时传' },
          steps: { type: 'array', description: '仅 create 时传：步骤列表，每项 name=步骤名称（必填）、desc=步骤要求（可选）', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' } }, required: ['name'] } },
          target: { type: 'string', description: '仅 abandon 时传' },
        },
        required: ['action'],
      },
    },
  };

  var ASK_TOOL = {
    type: 'function',
    function: {
      name: 'ask',
      description: '向用户提问。所有需要向用户提问的场景统一使用本工具（不要在正文中直接提问）：当现有信息不足、需要用户提供关键信息才能继续时，主动调用本工具提问，不要凭空假设。一次问 1~3 个问题（最多 5 个），每个问题独立成条、具体一次问清。',
      parameters: {
        type: 'object',
        properties: {
          questions: { type: 'array', items: { type: 'string' }, description: '要问的问题列表，正常 1~3 条（最多 5 条）' },
        },
        required: ['questions'],
      },
    },
  };

  var KB_TOOL = {
    type: 'function',
    function: {
      name: 'knowledge_query',
      description: '从知识库中检索与所需信息相关的 md 文档，返回其绝对路径列表。知识库位于数据目录 knowledge/ 下，每个一级文件夹是一个独立知识库，每个 md 文档头部带 YAML 元信息（title/description）。调用时把「你需要哪些信息」写清楚，返回相关文档的绝对路径（每行一个），随后用 read 工具读取这些路径即可获取内容。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '需要检索的信息描述' } },
        required: ['query'],
      },
    },
  };

  var CONVERSATION_QUERY_TOOL = {
    type: 'function',
    function: {
      name: 'conversation_query',
      description: '对话查询工具：查询任意对话的信息，全局范围（覆盖所有档案的对话），返回每个对话的标题、所属档案、聊天记录文件夹绝对地址与对话简述。调用方式一（已知对话编号）：传入 conv_id，返回该对话的信息；调用方式二：不传 conv_id，返回全部对话清单。',
      parameters: {
        type: 'object',
        properties: { conv_id: { type: 'string', description: '对话编号（可选）' } },
        required: [],
      },
    },
  };

  var LIREN_PAIPAN_TOOL = {
    type: 'function',
    function: {
      name: 'liuren_paipan',
      description: '大六壬排盘工具：完成六壬起课，返回结果文件的绝对路径（JSON，含完整课式：四柱/天盘/神盘/四课/三传/课格/旺衰/神煞等）。AI 只负责传入用户提供的信息，换算（报数→时辰、农历→公历、四柱月将、当前时间）由工具自动完成。模式（zhs）：正时（默认）/ 活时报数 / 四柱。',
      parameters: {
        type: 'object',
        properties: {
          zhs: { type: 'string', enum: ['正时', '活时报数', '四柱'], description: '起课方式' },
          sex: { type: 'string', enum: ['男', '女'], description: '性别（用于行年推算）' },
          age: { type: 'integer', description: '出生年份或年龄（<100 视为年龄，>100 视为出生年份）' },
          dt: { type: 'object', description: '按模式而定：正时/活时报数为公历时间 {y,m,d,h,i}；四柱为干支串 {y:"甲子", m:"戌", d:"戊午", h:"巳"}' },
          baoshu: { description: '活时报数模式的报数：数字或地支汉字' },
          yj: { type: 'string', description: '四柱模式月将' },
        },
        required: ['zhs'],
      },
    },
  };

  var LIUYAO_QIGUA_TOOL = {
    type: 'function',
    function: {
      name: 'liuyao_qigua',
      description: '六爻起卦工具：完成六爻起卦与纳甲装卦，返回结果文件的绝对路径（JSON，含完整卦象：本卦/之卦/六十四卦卦爻辞/纳甲地支/六亲/六神/世应/旬空/月破/旺衰等）。AI 只负责传入用户提供的信息，起卦（摇卦/时间换算/手动爻值）与纳甲装卦由工具自动完成。模式（method）：铜钱（默认）/ 蓍草 / 时间 / 手动。',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['铜钱', '蓍草', '时间', '手动'], description: '起卦方式' },
          dt: { type: 'object', description: '时间起卦模式的时间 {y,m,d,h,i}（缺省=当前时间）' },
          yao_values: { type: 'array', items: { type: 'integer' }, description: '手动模式：6 个爻值（6=老阴 7=少阳 8=少阴 9=老阳，从初爻到上爻）' },
        },
        required: ['method'],
      },
    },
  };

  var TOOLS = [READ_TOOL, WRITE_TOOL, BASH_TOOL, SPAWN_SUBAGENT_TOOL, TASK_TOOL,
    ASK_TOOL, KB_TOOL, CONVERSATION_QUERY_TOOL, LIREN_PAIPAN_TOOL, LIUYAO_QIGUA_TOOL];

  // ══════════════════════════════════════════
  // 技能系统（对应 tools.py 技能部分）
  // ══════════════════════════════════════════

  function parseSkillFrontmatter(text) {
    if (!text || text.indexOf('---') !== 0) return {};
    var meta = {};
    var currentKey = null;
    var lines = text.split('\n').slice(1);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var stripped = line.trim();
      if (stripped === '---') break;
      if (!stripped) continue;
      if (line[0] === ' ' || line[0] === '\t') {
        if (currentKey) meta[currentKey] = ((meta[currentKey] || '') + '\n' + stripped).trim();
        continue;
      }
      var ci = line.indexOf(':');
      if (ci < 0) { currentKey = null; continue; }
      currentKey = line.slice(0, ci).trim();
      var val = line.slice(ci + 1).trim();
      if (currentKey === 'name' || currentKey === 'description') {
        meta[currentKey] = (val === '|' || val === '>' || val === '') ? '' : val;
      }
    }
    return meta;
  }

  /** 扫描 skills 目录（assets/skills/<dir>/SKILL.md） */
  function scanSkills() {
    var out = [];
    try {
      var dirs = JSON.parse(N.listAssetDir('app/skills') || '[]');
      dirs.sort();
      dirs.forEach(function (dir) {
        if (dir === 'README.md') return;
        var text = N.readAsset('app/skills/' + dir + '/SKILL.md');
        if (!text) return;
        var meta = parseSkillFrontmatter(text);
        var name = meta.name || dir;
        var description = meta.description || '';
        if (!description) return;
        out.push({ name: name, description: description, content: text, dir: 'skills/' + dir });
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function buildSkillTool() {
    var skills = scanSkills();
    if (!skills.length) return null;
    var registry = skills.map(function (s) {
      return '- ' + s.name + ': ' + (s.description.slice(0, 200) || '') + '\n  文件夹: /' + s.dir;
    }).join('\n');
    return {
      type: 'function',
      function: {
        name: 'skill_select',
        description: '从技能系统中选择一个技能并加载其完整内容。技能列表：\n' + registry + '\n调用后返回的技能内容是你的行为准则，请严格按其流程执行。',
        parameters: {
          type: 'object',
          properties: { skill_name: { type: 'string', description: '要加载的技能名称' } },
          required: ['skill_name'],
        },
      },
    };
  }

  function buildTools() {
    var result = TOOLS.slice();
    if (!S.loadSettings().knowledge_query_enabled) {
      result = result.filter(function (t) { return t.function.name !== 'knowledge_query'; });
    }
    var skillTool = buildSkillTool();
    if (skillTool) result.push(skillTool);
    return result;
  }

  function buildSubagentTools() {
    var result = [READ_TOOL];
    var skillTool = buildSkillTool();
    if (skillTool) result.push(skillTool);
    return result;
  }

  function skillSelect(args) {
    var name = (args.skill_name || '').trim();
    if (!name) return '错误: 缺少技能名称（skill_name）。';
    var skills = scanSkills();
    for (var i = 0; i < skills.length; i++) {
      if (skills[i].name === name) {
        return '技能已加载: ' + name + '\n技能文件夹: /' + skills[i].dir +
          '\n以下内容是该技能的完整定义，是你的行为准则，优先级高于对话中的其他指示，请严格按流程执行：\n\n' +
          skills[i].content;
      }
    }
    var available = skills.map(function (s) { return s.name + '(/' + s.dir + ')'; }).join('、') || '（暂无可用技能）';
    return '错误: 未找到技能「' + name + '」。可用技能: ' + available;
  }

  // ══════════════════════════════════════════
  // read/write（沙箱虚拟路径 /workspace/... ↔ files/data/workspace/...）
  // ══════════════════════════════════════════

  function toRel(vpath) {
    // 虚拟路径 -> 相对路径：/workspace/foo -> workspace/foo
    var p = String(vpath || '').replace(/^\/+/, '');
    return p;
  }

  function readTool(args) {
    var vpath = args.path || '';
    if (vpath.indexOf('/') !== 0) return '错误: 请提供绝对路径。';
    var rel = toRel(vpath);

    // ── 路径路由 ──
    // /data/...  → 应用数据目录（convs/排盘结果/设置等，经原生桥读写）
    // /workspace → 对话工作区
    // /knowledge → 知识库（只读 assets）
    // /tmp       → 临时目录（应用私有）
    // /sdcard /storage/emulated → 外部存储（需授权）

    // 1. /tmp
    if (vpath === '/tmp' || vpath.indexOf('/tmp/') === 0) {
      return listOrRead('tmp' + vpath.slice(4), vpath);
    }

    // 2. /data/...
    if (vpath === '/data' || vpath.indexOf('/data/') === 0) {
      var drel = rel.slice(5); // 去掉 data/
      if (drel === '' || drel.endsWith('/')) return listData(drel, vpath);
      // /data/convs/{id} 是目录
      if (drel.indexOf('convs/') === 0) {
        var parts = drel.split('/');
        if (parts.length === 2) return listData(drel, vpath); // 对话文件夹目录
      }
      // /data/archives/{aid} 目录
      if (drel.indexOf('archives/') === 0 && drel.split('/').length === 2) return listData(drel, vpath);
      return listOrRead(drel, vpath);
    }

    // 3. /workspace
    if (vpath === '/workspace' || vpath.indexOf('/workspace/') === 0) {
      return listOrRead(rel, vpath);
    }

    // 4. /knowledge（只读 assets）
    if (vpath === '/knowledge' || vpath.indexOf('/knowledge/') === 0) {
      return knowledgeRead(rel, vpath);
    }

    // 5. /skills（技能文件夹，只读 assets）
    if (vpath === '/skills' || vpath.indexOf('/skills/') === 0) {
      return assetReadOrList(rel, vpath);
    }

    // 6. 外部存储
    if (vpath.indexOf('/sdcard') === 0 || vpath.indexOf('/storage/emulated') === 0) {
      return externalRead(vpath);
    }

    return '错误: 无权限访问路径: ' + vpath;
  }

  // 应用数据目录列表（原生桥 listDir）
  function listData(drel, vpath) {
    try {
      var names = JSON.parse(N.listDir(drel) || '[]');
      if (!names.length) return '目录为空: ' + vpath;
      names.sort();
      var dirs = [], files = [];
      // 区分目录与文件：桥只返回名字，用 exists+trailing 判断（简化：按是否有子项）
      names.forEach(function (n) {
        var sub = N.listDir(drel ? drel + '/' + n : n);
        if (sub && sub !== '[]') dirs.push(n + '/');
        else files.push(n);
      });
      return '目录: ' + vpath + '\n' + dirs.concat(files).map(function (x) { return '  ' + x; }).join('\n');
    } catch (e) {
      return '错误: 无法读取目录: ' + vpath;
    }
  }

  // 通用 列表/读取
  function listOrRead(drel, vpath) {
    // 先尝试读文件
    var raw = N.readFile(drel);
    if (raw !== null) {
      readCache[vpath] = true;
      var lines = raw.split('\n');
      return lines.map(function (l, i) { return (i + 1) + '\t' + l; }).join('\n');
    }
    // 不是文件 → 尝试列目录
    var listed = listData(drel, vpath);
    if (listed.indexOf('错误') !== 0) return listed;
    return '错误: 文件不存在: ' + vpath;
  }

  // 知识库读取：完全基于内存索引（buildKbIndex 已缓存全部内容），
  // 不调用原生桥 —— 彻底避免中文/不存在路径在 Android assets 上卡死。
  function knowledgeRead(rel, vpath) {
    var index = buildKbIndex();
    // 1. 完全匹配文件路径 → 返回缓存内容
    for (var i = 0; i < index.length; i++) {
      if (index[i].path === vpath) {
        readCache[vpath] = true;
        var lines = index[i].content.split('\n');
        return lines.map(function (l, j) { return (j + 1) + '\t' + l; }).join('\n');
      }
    }
    // 2. 目录：匹配以 vpath/ 开头的文件 → 列出直接子项
    var prefix = vpath.replace(/\/$/, '') + '/';
    var subFiles = index.filter(function (f) { return f.path.indexOf(prefix) === 0; });
    if (subFiles.length) {
      var names = {};
      subFiles.forEach(function (f) {
        var rest = f.path.slice(prefix.length);
        var first = rest.split('/')[0];
        if (first) names[first] = true;
      });
      return '目录: ' + vpath + '\n' + Object.keys(names).sort().map(function (x) {
        return '  ' + x + '/';
      }).join('\n');
    }
    // 3. 根目录 /knowledge
    if (vpath === '/knowledge') {
      var libs = {};
      index.forEach(function (f) { libs[f.lib] = true; });
      return '目录: /knowledge\n' + Object.keys(libs).sort().map(function (x) { return '  ' + x + '/'; }).join('\n');
    }
    // 4. 不存在 → 秒回错误（不触碰原生桥）
    return '错误: 文件不存在: ' + vpath;
  }

  // 通用 assets 读取/列表：避免 readAsset 打开目录导致卡死
  function assetReadOrList(assetRel, vpath) {
    // 先列目录：若返回非空 → 是目录；空数组 → 是文件或不存在
    var listed = [];
    try {
      listed = JSON.parse(N.listAssetDir('app/' + assetRel) || '[]');
    } catch (e) { listed = []; }
    if (listed.length) {
      // 目录 → 列出（区分 md 文件与子目录）
      return '目录: ' + vpath + '\n' + listed.sort().map(function (x) {
        return '  ' + x + (x.indexOf('.') >= 0 ? '' : '/');
      }).join('\n');
    }
    // 非目录 → 尝试当文件读
    var raw = N.readAsset('app/' + assetRel);
    if (raw !== null) {
      readCache[vpath] = true;
      var lines = raw.split('\n');
      return lines.map(function (l, i) { return (i + 1) + '\t' + l; }).join('\n');
    }
    return '错误: 文件不存在: ' + vpath;
  }

  // 外部存储读取/列表
  function externalRead(vpath) {
    try {
      var extDir = N.listExternal(vpath);
      if (extDir && extDir !== '[]') {
        var items = JSON.parse(extDir);
        var dirs = items.filter(function (x) { return x.isDir; }).map(function (x) { return x.name + '/'; });
        var files = items.filter(function (x) { return !x.isDir; }).map(function (x) { return x.name + ' (' + x.size + ' 字节)'; });
        return '目录: ' + vpath + '\n' + dirs.concat(files).join('\n');
      }
    } catch (e) {}
    var ext = N.readExternal(vpath);
    if (ext === null) return '错误: 无法读取文件（请先在设置→权限中授予存储权限）: ' + vpath;
    if (ext.indexOf('[文件过大') === 0) return ext;
    readCache[vpath] = true;
    var extLines = ext.split('\n');
    return extLines.map(function (l, i) { return (i + 1) + '\t' + l; }).join('\n');
  }

  function writeTool(args) {
    var vpath = args.path || '';
    var content = args.content || '';
    if (vpath.indexOf('/') !== 0) return '错误: 请提供绝对路径。';
    var rel = toRel(vpath);
    if (rel.indexOf('workspace') !== 0) {
      return '错误: 移动端仅可写入 /workspace/ 目录。';
    }
    if (N.exists(rel) && !readCache[vpath]) {
      return '错误: 文件已存在，请先使用 Read 读取文件内容后再修改。\n文件: ' + vpath;
    }
    var ok = N.writeFile(rel, content);
    if (!ok) return '错误: 写入文件失败: ' + vpath;
    readCache[vpath] = true;
    return '文件已写入: ' + vpath + ' (' + content.length + ' 字符)';
  }

  // ══════════════════════════════════════════
  // 六壬排盘（对应 tools.py _liuren_paipan）
  // ══════════════════════════════════════════

  function liurenPaipan(args) {
    args = args || {};
    var zhs = String(args.zhs || '正时');
    if (zhs === '正时' && !args.dt) {
      var now = new Date();
      args.dt = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), i: now.getMinutes() };
    }
    try {
      var params = global.LiurenEngine.resolveIntent(args);
      var result = global.LiurenEngine.paipan(params);
      var filename = 'liuren_paipan_' + ts() + '_' + S.uid8() + '.json';
      var rel = 'liuren_paipan/' + filename;
      if (!N.writeFile(rel, JSON.stringify(result, null, 2))) {
        return '错误: 写入结果文件失败: ' + rel;
      }
      return '/data/liuren_paipan/' + filename;
    } catch (e) {
      return '错误: ' + e.message;
    }
  }

  // ══════════════════════════════════════════
  // 六爻起卦（对应 tools.py _liuyao_qigua）
  // ══════════════════════════════════════════

  function liuyaoQigua(args) {
    args = args || {};
    try {
      var params = global.LiuyaoEngine.resolveIntent(args);
      var result = global.LiuyaoEngine.qigua(
        params.method, params.dt, params.yao_values, undefined);
      var filename = 'liuyao_qigua_' + ts() + '_' + S.uid8() + '.json';
      var rel = 'liuyao_qigua/' + filename;
      if (!N.writeFile(rel, JSON.stringify(result, null, 2))) {
        return '错误: 写入结果文件失败: ' + rel;
      }
      return '/data/liuyao_qigua/' + filename;
    } catch (e) {
      return '错误: ' + e.message;
    }
  }

  function ts() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ══════════════════════════════════════════
  // 对话查询（对应 tools.py _conversation_query，简化版）
  // ══════════════════════════════════════════

  function conversationQuery(args) {
    args = args || {};
    var convId = String(args.conv_id || '').trim();
    var convs = S.loadConversations();
    if (convId) {
      var target = null;
      for (var i = 0; i < convs.length; i++) if (convs[i].id === convId) { target = convs[i]; break; }
      if (!target) return '错误: 未找到对话「' + convId + '」。请不传 conv_id 查询全部对话列表。';
      convs = [target];
    }
    var lines = convs.map(function (c) {
      var cid = c.id;
      var title = c.title || '新对话';
      var archiveName = c.folder ? '自定义档案' : '默认档案';
      var path = '/data/convs/' + cid;
      var region = '（暂无对话简述）';
      return '【对话 ' + cid + '】标题：' + title + '\n档案：' + archiveName +
        '\n聊天记录：' + path + '\n简述：' + region;
    });
    return lines.join('\n\n');
  }

  // ══════════════════════════════════════════
  // 知识库检索（对应 kb.py，简化版：标题/描述/内容关键词匹配）
  // ══════════════════════════════════════════

  var kbIndexCache = null;

  function buildKbIndex() {
    if (kbIndexCache) return kbIndexCache;
    var out = [];
    try {
      var libs = JSON.parse(N.listAssetDir('app/data/knowledge') || '[]');
      libs.forEach(function (lib) {
        scanDir('app/data/knowledge/' + lib, lib, out);
      });
    } catch (e) { /* ignore */ }
    kbIndexCache = out;
    return out;
  }

  function scanDir(prefix, lib, out) {
    try {
      var entries = JSON.parse(N.listAssetDir(prefix) || '[]');
      entries.forEach(function (name) {
        var full = prefix + '/' + name;
        if (name.endsWith('.md')) {
          var text = N.readAsset(full);
          if (text) {
            var meta = parseSkillFrontmatter(text);
            var relFromKb = full.replace(/^app\/data\/knowledge\//, '');
            out.push({
              lib: lib, path: '/knowledge/' + relFromKb,
              title: meta.title || name.replace(/\.md$/, ''),
              description: meta.description || '',
              content: text,
            });
          }
        } else {
          // 子目录递归（一层）
          scanDir(full, lib, out);
        }
      });
    } catch (e) { /* ignore */ }
  }

  function knowledgeQuery(args) {
    var query = String(args.query || '').trim();
    if (!query) return '错误: 缺少查询内容。';
    var index = buildKbIndex();
    // 关键词打分：查询词在 title/description/content 中出现的次数
    var scored = [];
    index.forEach(function (doc) {
      var score = 0;
      var q = query;
      if (doc.title && doc.title.indexOf(q) >= 0) score += 10;
      if (doc.description && doc.description.indexOf(q) >= 0) score += 5;
      if (doc.content && doc.content.indexOf(q) >= 0) score += 1;
      // 逐字匹配提高召回
      if (q.length >= 2) {
        for (var i = 0; i + 1 < q.length; i++) {
          var bigram = q.slice(i, i + 2);
          if (doc.title && doc.title.indexOf(bigram) >= 0) score += 2;
          if (doc.description && doc.description.indexOf(bigram) >= 0) score += 1;
        }
      }
      if (score > 0) scored.push({ doc: doc, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.slice(0, 10);
    if (!top.length) return '未找到与「' + query + '」相关的文档。';
    var lines = top.map(function (s) {
      return s.doc.path + '（' + s.doc.title + '）';
    });
    return '相关文档（按相关度排序）：\n' + lines.join('\n');
  }

  // ══════════════════════════════════════════
  // 任务工具（对应 backend/tasks.py，简化版：无裁判子代理，直接推进）
  // ══════════════════════════════════════════

  var taskToolDone = { done: false };

  function executeTask(action, args, convId) {
    args = args || {};
    action = action || args.action || '';
    var result = '';
    var taskDone = false;

    if (action === 'create') {
      var steps = (args.steps || []).map(function (st, i) {
        return { index: i + 1, name: st.name, desc: st.desc || '', status: '待执行' };
      });
      var task = S.createTask(convId, args.source || 'user', steps);
      result = '任务清单已创建: ' + task.id + '（' + steps.length + ' 步）\n' +
        steps.map(function (s) { return s.index + '. ' + s.name + (s.desc ? ' - ' + s.desc : ''); }).join('\n');
    } else if (action === 'start') {
      var tasks = S.listTasks(convId);
      var cur = null;
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].status !== '已完成' && tasks[i].status !== '废弃') {
          var steps2 = tasks[i].steps;
          for (var j = 0; j < steps2.length; j++) {
            if (steps2[j].status === '待执行') {
              steps2[j].status = '执行中';
              cur = tasks[i];
              break;
            }
          }
          if (cur) break;
        }
      }
      if (cur) {
        S.updateTask(convId, cur.id, { steps: cur.steps });
        result = '已开始执行步骤: ' + cur.id;
      } else {
        result = '当前没有待执行的步骤。';
      }
    } else if (action === 'complete') {
      var tasks2 = S.listTasks(convId);
      var doneTask = null;
      for (var i = 0; i < tasks2.length; i++) {
        if (tasks2[i].status !== '已完成' && tasks2[i].status !== '废弃') {
          var steps3 = tasks2[i].steps;
          var allDone = true;
          for (var j = 0; j < steps3.length; j++) {
            if (steps3[j].status === '执行中') { steps3[j].status = '已执行'; }
            if (steps3[j].status !== '已执行') allDone = false;
          }
          if (allDone) {
            tasks2[i].status = '已完成';
            tasks2[i].finished_at = S.now();
            taskDone = true;
          }
          doneTask = tasks2[i];
          break;
        }
      }
      if (doneTask) {
        S.updateTask(convId, doneTask.id, { steps: doneTask.steps, status: doneTask.status, finished_at: doneTask.finished_at });
        result = taskDone
          ? '任务清单已完成: ' + doneTask.id + '，全部步骤执行完毕。'
          : '步骤已完成，继续执行下一步。';
      } else {
        result = '当前没有执行中的任务。';
      }
    } else if (action === 'abandon') {
      var target = args.target;
      var tasks3 = S.listTasks(convId);
      for (var i = 0; i < tasks3.length; i++) {
        var t = tasks3[i];
        if (t.status === '已完成' || t.status === '废弃') continue;
        if (target === 'task') {
          t.status = '废弃';
          t.finished_at = S.now();
          S.updateTask(convId, t.id, { status: '废弃', finished_at: t.finished_at });
          result = '任务已废弃: ' + t.id;
        } else if (target) {
          var si = parseInt(target, 10);
          if (t.steps[si - 1]) {
            t.steps[si - 1].status = '废弃';
            S.updateTask(convId, t.id, { steps: t.steps });
            result = '步骤已废弃: ' + t.id + ' 第 ' + si + ' 步';
          } else {
            result = '错误: 步骤不存在: ' + target;
          }
        } else {
          var curStep = null;
          for (var j = 0; j < t.steps.length; j++) {
            if (t.steps[j].status === '执行中') { curStep = t.steps[j]; t.steps[j].status = '废弃'; break; }
          }
          if (curStep) {
            S.updateTask(convId, t.id, { steps: t.steps });
            result = '当前步骤已废弃。';
          } else {
            result = '当前没有执行中的步骤可废弃。';
          }
        }
        break;
      }
      if (!result) result = '没有可废弃的任务。';
    } else {
      result = '错误: 未知 action: ' + action;
    }
    return { result: result, done: taskDone };
  }

  // ══════════════════════════════════════════
  // 分发执行（对应 tools.py execute_tool）
  // ══════════════════════════════════════════

  function executeTool(name, arguments_, convId) {
    arguments_ = arguments_ || {};
    switch (name) {
      case 'read': return readTool(arguments_);
      case 'write': return writeTool(arguments_);
      case 'bash': return '错误: 移动端不支持 shell 命令。';
      case 'skill_select': return skillSelect(arguments_);
      case 'spawn_subagent': return '错误: spawn_subagent 需要异步执行上下文（由对话引擎分发子代理）。';
      case 'task': return '错误: task 需要异步执行上下文（由对话引擎分发，见 chat.js）。';
      case 'ask': return '错误: ask 需要异步执行上下文（由对话引擎分发，见 chat.js）。';
      case 'knowledge_query': return '错误: 索引知识库需要异步执行上下文（由对话引擎分发，见 chat.js）。';
      case 'conversation_query': return conversationQuery(arguments_);
      case 'liuren_paipan': return liurenPaipan(arguments_);
      case 'liuyao_qigua': return liuyaoQigua(arguments_);
      default: return '未知工具: ' + name;
    }
  }

  var api = {
    buildTools: buildTools, buildSubagentTools: buildSubagentTools,
    executeTool: executeTool, executeTask: executeTask,
    scanSkills: scanSkills, skillSelect: skillSelect,
    buildKbIndex: buildKbIndex, knowledgeQuery: knowledgeQuery,
    conversationQuery: conversationQuery,
    readTool: readTool, writeTool: writeTool,
  };

  global.PusuanTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
