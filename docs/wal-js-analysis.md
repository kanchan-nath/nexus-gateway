# `wal.js`

## Purpose

`wal.js` implements a **Write-Ahead Log (WAL)** for Nexus.

It records requests before they are forwarded to a backend, providing:
- Request durability
- Audit history
- Request replay
- Log rotation
- WAL statistics

It uses Node.js built-in modules such as `fs`, `path`, and `stream`, avoiding external logging or queue libraries.

## Context

The WAL sits between request handling and backend forwarding.

```text
Incoming Request
       ↓
server.js
       ↓
wal.append()
       ↓
WAL Buffer
       ↓
Log File
       ↓
Backend
