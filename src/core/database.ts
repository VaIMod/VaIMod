// 本地数据仓库（合并自 D:\Desktop\ccwdata.js 的 Database 类）
// 在 VaIMod 中作为「云数据编辑草稿 / 本地镜像」使用：保存后写入，便于「保存全部」判断改动。

export type DatabaseValue = unknown;

export type DatabaseWatcher = (oldVal: DatabaseValue, newVal: DatabaseValue) => DatabaseValue;

export class Database {
  private data = new Map<string, DatabaseValue>();
  private watchers = new Map<string, DatabaseWatcher>();

  watch(key: string, callback: DatabaseWatcher): void {
    this.watchers.set(key, callback);
  }

  set(key: string, value: DatabaseValue): void {
    if (this.data.get(key) === value) return;
    const watcher = this.watchers.get(key);
    if (watcher) {
      this.data.set(key, watcher(this.data.get(key), value));
    } else {
      this.data.set(key, value);
    }
  }

  get(key: string): DatabaseValue {
    return this.data.get(key);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  entries(): IterableIterator<[string, DatabaseValue]> {
    return this.data.entries();
  }

  values(): IterableIterator<DatabaseValue> {
    return this.data.values();
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  /** 删除某个云数据项，并通知观察者 */
  delete(key: string): boolean {
    if (!this.data.has(key)) return false;
    this.data.delete(key);
    this.watchers.get(key)?.(undefined, undefined);
    return true;
  }

  /** 清空全部数据 */
  clear(): void {
    const names = [...this.data.keys()];
    this.data.clear();
    for (const name of names) this.watchers.get(name)?.(undefined, undefined);
  }

  /** 序列化为普通对象（便于云同步 / 导入导出） */
  toJSON(): Record<string, DatabaseValue> {
    const obj: Record<string, DatabaseValue> = {};
    for (const [k, v] of this.data) obj[k] = v;
    return obj;
  }

  /** 从普通对象批量写入 */
  fromJSON(obj: Record<string, DatabaseValue>): void {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) this.set(k, v);
  }

  /** 根据当前值的类型，把输入框原始字符串转换为正确类型 */
  static coerce(raw: string, current: DatabaseValue): DatabaseValue {
    if (Array.isArray(current)) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if (typeof current === 'number') {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    if (typeof current === 'boolean') {
      return raw === 'true';
    }
    return raw;
  }
}
