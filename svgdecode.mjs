import { readFileSync } from 'fs';
// 从用户消息提取 base64（完整 data URI）
const raw = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0i`;
// 直接从文件读（用临时文件方式：先写到文件再读不行，直接在这处理用户粘贴的完整 base64）
// 方案：用户消息里的 base64 太长，改用从剪贴板文件读取——这里直接解析一个更简单的方式：
// 由于 base64 在消息里，我把它写入临时文件
