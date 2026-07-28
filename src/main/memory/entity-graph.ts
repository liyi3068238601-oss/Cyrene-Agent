// 简易实体关系图谱
//
// 从对话中自动提取实体（人物、地点、偏好、概念）和关系，
// 弥补纯向量检索无法回答"用户提到过的朋友是谁"这类关系型问题的不足。
//
// 存储为 JSON 文件，与 memory.json 并列。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { registerJiebaCustomWord, registerJiebaCustomWords } from "../rag/retriever";
import type { ExtractedEntity } from "./memory-types";

// ── 类型 ──

export interface EntityNode {
  id: string;
  name: string;
  type: "person" | "place" | "concept" | "preference" | "organization";
  aliases: string[];         // 其他叫法
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
}

export interface EntityRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;          // "likes" | "works_at" | "lives_in" | "friend_of" | "owns" | ...
  confidence: number;        // 0.0 ~ 1.0
  strength: number;          // 提及次数累积
}

interface EntityGraphData {
  entities: EntityNode[];
  relations: EntityRelation[];
}

// ── 简单解析器（正则启发式提取，作为 LLM 提取的 fallback） ──

/**
 * 实体名停用字符集：标点、空格、换行、以及"的"等修饰助词。
 * 用 [^停用字符] 替代通配 . ，避免贪婪匹配把实体名后的句子碎片
 * 也吃进来——这是实体名"断裂"（如"昨晚睡前的那份纯然的"）的根因。
 */
const NAME_STOP = "，。、！？…—\\s,.;:!?()'\"「」『』（）【】；：·~的"
const NAME_CHAR = `[^${NAME_STOP}]`

// 常见实体触发模式
const ENTITY_PATTERNS: Array<{ type: EntityNode["type"]; patterns: RegExp[] }> = [
  {
    type: "person",
    patterns: [
      new RegExp(`我的朋友(${NAME_CHAR}{1,6})`, "g"),
      new RegExp(`我认识(${NAME_CHAR}{1,6})`, "g"),
      new RegExp(`同事(${NAME_CHAR}{1,6})`, "g"),
      new RegExp(`叫(${NAME_CHAR}{1,4})(?:的人|的朋友|的同事|的老板)`, "g"),
      new RegExp(`有.{0,4}朋友.{0,4}(${NAME_CHAR}{1,6})`, "g"),
      new RegExp(`(${NAME_CHAR}{1,4})是我的朋友`, "g"),
    ],
  },
  {
    type: "place",
    patterns: [
      new RegExp(`住在(${NAME_CHAR}{1,8})`, "g"),
      new RegExp(`在(${NAME_CHAR}{1,8})(?:工作|学习|生活|上班|上学)`, "g"),
      new RegExp(`去了(${NAME_CHAR}{1,8})`, "g"),
      new RegExp(`在(${NAME_CHAR}{1,8})出差`, "g"),
      new RegExp(`在(${NAME_CHAR}{1,8})城市`, "g"),
      new RegExp(`来自(${NAME_CHAR}{1,8})`, "g"),
    ],
  },
  {
    type: "organization",
    patterns: [
      new RegExp(`在(${NAME_CHAR}{1,8})(?:公司|单位|工作室|团队|学校|大学|学院)`, "g"),
      new RegExp(`(${NAME_CHAR}{1,8})公司`, "g"),
    ],
  },
  {
    type: "preference",
    patterns: [
      new RegExp(`喜欢(${NAME_CHAR}{1,8})(?:的东西|的活动|的食物|的音乐|的运动|的游戏|的动画|的漫画)`, "g"),
      new RegExp(`最爱(${NAME_CHAR}{1,8})`, "g"),
      new RegExp(`讨厌(${NAME_CHAR}{1,8})(?:的东西|的事情)`, "g"),
    ],
  },
];

/** 从文本中启发式提取实体名，返回 [type, name] 列表 */
export function extractEntitiesFromText(text: string): Array<{ type: EntityNode["type"]; name: string }> {
  const results: Array<{ type: EntityNode["type"]; name: string }> = [];
  const seen = new Set<string>();

  for (const { type, patterns } of ENTITY_PATTERNS) {
    for (const regex of patterns) {
      const matches = text.matchAll(regex);
      for (const m of matches) {
        const name = m[1]?.trim();
        if (name && name.length >= 2 && name.length <= 10 && !seen.has(`${type}:${name}`)) {
          seen.add(`${type}:${name}`);
          results.push({ type, name });
        }
      }
    }
  }

  // 过滤垃圾实体：含标点、省略号、引号、括号等非实体名碎片
  const PUNCTUATION_PATTERN = /[，。、！？…—\.\（\）「」『』"';；：]/
  return results.filter((r) => !PUNCTUATION_PATTERN.test(r.name));
}

// ── 实体图谱管理器 ──

const dataDir = () => path.join(app.getPath("userData"));
const getPath = () => path.join(dataDir(), "entity-graph.json");

class EntityGraph {
  private cache: EntityGraphData | null = null;

  load(): EntityGraphData {
    if (this.cache) return this.cache;
    try {
      const filePath = getPath();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        this.cache = JSON.parse(raw) as EntityGraphData;
      } else {
        this.cache = { entities: [], relations: [] };
      }
    } catch {
      this.cache = { entities: [], relations: [] };
    }
    return this.cache;
  }

  save(): void {
    if (!this.cache) return;
    const filePath = getPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.cache, null, 2), "utf8");
  }

  /** 接收 LLM 提取的实体列表并入库（优先于正则 ingest 使用） */
  ingestEntities(entities: ExtractedEntity[]): void {
    if (!entities || entities.length === 0) return;
    const data = this.load();
    const now = Date.now();
    const PUNCTUATION = /[，。、！？…—\.\（\）「」『』"';；：\s]/

    for (const { type, name } of entities) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length < 2 || trimmed.length > 20) continue;
      if (PUNCTUATION.test(trimmed)) continue;

      const existing = data.entities.find(
        (e) => e.name === trimmed || e.aliases.includes(trimmed),
      );
      if (existing) {
        existing.mentionCount++;
        existing.lastMentionedAt = now;
      } else {
        data.entities.push({
          id: `ent_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name: trimmed,
          type,
          aliases: [],
          mentionCount: 1,
          firstMentionedAt: now,
          lastMentionedAt: now,
        });
        this.feedSingleName(trimmed);
      }
    }

    this.save();
  }

  /** 从一条对话文本中提取实体并入库（正则 fallback） */
  ingest(text: string): void {
    const data = this.load();
    const extracted = extractEntitiesFromText(text);
    const now = Date.now();
    let hasNewEntity = false;

    for (const { type, name } of extracted) {
      const existing = data.entities.find(
        (e) => e.name === name || e.aliases.includes(name),
      );
      if (existing) {
        existing.mentionCount++;
        existing.lastMentionedAt = now;
      } else {
        data.entities.push({
          id: `ent_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          type,
          aliases: [],
          mentionCount: 1,
          firstMentionedAt: now,
          lastMentionedAt: now,
        });
        hasNewEntity = true;
        // 新实体立即喂给 jieba，避免后续对话中该词被错误切分
        this.feedSingleName(name);
      }
    }

    if (extracted.length > 0) this.save();
  }

/**
 * 把一个名称注册到 jieba 自定义词表。
 *
 * @node-rs/jieba 没有运行时 insertWord() —— 走「后处理重组」方案：
 * retriever.ts 的 tokenize() 在 jieba.cut() 之后会把被切散的自定义词
 * 重新合并。这个函数就是把 entity 名加进那张表的入口。
 */
  private feedSingleName(name: string): void {
    registerJiebaCustomWord(name);
  }

  /** 搜索与 query 相关的实体和关系，返回可读文本 */
  search(query: string): string {
    const data = this.load();
    if (data.entities.length === 0) return "";

    // 简单关键词匹配：找名称包含 query 中任意词的实体
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matchedEntities = data.entities.filter((e) =>
      queryTokens.some((t) => e.name.includes(t) || e.aliases.some((a) => a.includes(t))),
    );

    if (matchedEntities.length === 0) return "";

    const lines: string[] = [];
    for (const entity of matchedEntities) {
      const mentions = entity.mentionCount > 1 ? `（提及${entity.mentionCount}次）` : "";
      lines.push(`· ${entity.name}（${typeLabel(entity.type)}）${mentions}`);

      // 找该实体相关的所有关系
      const outgoing = data.relations.filter((r) => r.sourceId === entity.id);
      for (const rel of outgoing) {
        const target = data.entities.find((e) => e.id === rel.targetId);
        if (target) {
          lines.push(`  → ${rel.relation} ${target.name}`);
        }
      }

      const incoming = data.relations.filter((r) => r.targetId === entity.id);
      for (const rel of incoming) {
        const source = data.entities.find((e) => e.id === rel.sourceId);
        if (source) {
          lines.push(`  ← ${source.name} ${rel.relation}`);
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") : "";
  }

  /** 清空图谱 */
  reset(): void {
    this.cache = { entities: [], relations: [] };
    this.save();
  }
}

/** 获取所有实体名称（含别名） */
export function getAllEntityNames(): string[] {
  const graph = entityGraph.load();
  const names = new Set<string>();
  for (const e of graph.entities) {
    names.add(e.name);
    for (const a of e.aliases) names.add(a);
  }
  return [...names].filter((n) => n.length >= 2);
}

/**
 * 将实体图谱中的所有实体名注册到 jieba 自定义词表。
 * 调用时机：应用启动后、图谱有更新时。
 * 这样 "昔涟"、"小鹿" 等 AI 伴侣核心名词不会被错误切分。
 *
 * @node-rs/jieba 没有运行时 insertWord() —— 走「后处理重组」方案：
 * 词表存到 retriever.ts 的 customWords Set，tokenize() 切完后合并回去。
 */
export async function feedEntityNamesToJieba(): Promise<void> {
  const names = getAllEntityNames();
  if (names.length === 0) return;
  registerJiebaCustomWords(names);
  console.log(`[EntityGraph] 注册 ${names.length} 个实体名到 jieba 自定义词表`);
}

function typeLabel(type: EntityNode["type"]): string {
  switch (type) {
    case "person": return "人物";
    case "place": return "地点";
    case "organization": return "组织";
    case "preference": return "偏好";
    case "concept": return "概念";
  }
}

export const entityGraph = new EntityGraph();