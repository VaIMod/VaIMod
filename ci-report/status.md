# CI 诊断报告

- 生成时间：2026-10-03T14:31:13Z
- 触发事件：push
- 提交：d79fb44
- 仓库：VaIMod/VaIMod

## 仓库元信息（private / visibility / has_pages / default_branch）
```json
  "private": false,
  "owner": {
  "has_pages": true,
  "visibility": "public",
  "default_branch": "main",
{
  "id": 1377241024,
  "node_id": "R_kgDOUhcHwA",
  "name": "VaIMod",
  "full_name": "VaIMod/VaIMod",
  "private": false,
  "owner": {
    "login": "VaIMod",
    "id": 331295874,
    "node_id": "O_kgDOE78sgg",
    "avatar_url": "https://avatars.githubusercontent.com/u/331295874?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/VaIMod",
    "html_url": "https://github.com/VaIMod",
    "followers_url": "https://api.github.com/users/VaIMod/followers",
    "following_url": "https://api.github.com/users/VaIMod/following{/other_user}",
    "gists_url": "https://api.github.com/users/VaIMod/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/VaIMod/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/VaIMod/subscriptions",
    "organizations_url": "https://api.github.com/users/VaIMod/orgs",
    "repos_url": "https://api.github.com/users/VaIMod/repos",
    "events_url": "https://api.github.com/users/VaIMod/events{/privacy}",
    "received_events_url": "https://api.github.com/users/VaIMod/received_events",
    "type": "Organization",
    "user_view_type": "public",
    "site_admin": false
  },
  "html_url": "https://github.com/Va
```

## 账号计划（Free 私有仓库不支持 Pages）
```json
{
  "message": "Resource not accessible by integration",
  "documentation_url": "https://docs.github.com/rest/users/users#get-the-authenticated-user",
  "status": "403"
}

```

## Pages 当前状态（HTTP 404 = 从未启用）
```
GET /pages -> HTTP 200
{
  "url": "https://api.github.com/repos/VaIMod/VaIMod/pages",
  "status": null,
  "cname": null,
  "custom_404": false,
  "html_url": "https://vaimod.github.io/VaIMod/",
  "build_type": "workflow",
  "source": {
    "branch": "main",
    "path": "/"
  },
  "public": true,
  "protected_domain_state": null,
  "pending_domain_unverified_at": null,
  "https_enforced": true
}

```

## 尝试启用 Pages（build_type=workflow，失败原因写在响应体里）
```
POST /pages -> HTTP 403
{
  "message": "Resource not accessible by integration",
  "documentation_url": "https://docs.github.com/rest/pages/pages#create-a-apiname-pages-site",
  "status": "403"
}

```

## 最近 5 次工作流运行
```json
      "name": "Build & Deploy",
      "head_sha": "d79fb44c3e0f388fb794f1eb86998c418c44c172",
      "event": "push",
      "status": "in_progress",
      "conclusion": null,
      "created_at": "2026-10-03T14:31:08Z",
          "name": "Maxkore-Geek",
          "name": "Maxkore-Geek",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "4e661fb43fc1cdf72fb774c9e9a18b9a1e64bbcb",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-10-03T09:29:30Z",
          "name": "Maxkore-Geek",
          "name": "Maxkore-Geek",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "7884b1e792888d35ed955327273b6ab66b418c68",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-10-03T08:49:15Z",
          "name": "Maxkore-Geek",
          "name": "Maxkore-Geek",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "b880294369aa9c39542bf303d40012436bfde80e",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-10-02T08:22:55Z",
          "name": "Maxkore-Geek",
          "name": "Maxkore-Geek",
        "name": "VaIMod",
        "name": "VaIMod",
```
