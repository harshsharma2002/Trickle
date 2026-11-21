# Trickle

A minimal BitTorrent client written in Node.js for learning purposes. It reads a `.torrent` file, finds peers through trackers, downloads the pieces over TCP, verifies them, and writes the files to disk.

> **Status:** educational and experimental. It downloads only; it never uploads or seeds. Please don't use it as your daily client.

## Features

- Parses `.torrent` files (single-file and multi-file)
- Tracker support: **UDP** (BEP 15), **HTTP** and **HTTPS** (BEP 3), with compact peer lists (BEP 23) and IPv6 peers (BEP 7)
- Queries every tracker in `announce` and `announce-list` concurrently and merges the peers
- Peer wire protocol: handshake validation, choke/unchoke, `have`, `bitfield`, `request`, `piece`
- Request pipelining (5 outstanding requests per peer)
- SHA-1 verification of every piece before it is written to disk
- Re-requests blocks lost to disconnected or choking peers
- Path-traversal protection for multi-file torrents
- One runtime dependency (`bencode`)

## Requirements

- **Node.js 18 or newer**, for the global `fetch` and `AbortSignal.timeout`. Developed on Node 21.
- npm

## Installation

```bash
git clone <your-repo-url>
cd trickle
npm install
```

`package.json` must contain `"type": "module"`, since the project uses ES modules.

## Usage

```bash
npm start -- <path-to-file.torrent>
```

Examples:

```bash
npm start -- puppy.torrent
```

Quote paths that contain spaces. The `--` is required so npm passes the argument through to the script. You can also run it directly:

```bash
node index.js puppy.torrent
```

### Output

Files are written to `./<torrent name>` in the current working directory:

- **Single-file torrent:** a file with that name.
- **Multi-file torrent:** a folder with that name, containing the torrent's own directory structure.

The console shows the trackers queried, how many peers each returned, and a progress line:

```
  http://bittorrent.kali.org/announce -> 200 peers
  udp://bittorrent.kali.org:6969 -> 200 peers
Got 268 peers
progress: 12.4%
DONE!
```

The process exits when the download finishes, or when every peer has disconnected before it completes.

## Project structure

```
├── index.js              Entry point: reads the CLI argument, starts the download
└── src
    ├── download.js       Peer connections, message handling, file writing
    ├── message.js        Builds and parses BitTorrent wire messages
    ├── pieces.js         Tracks which blocks are requested/received
    ├── queue.js          Per-peer state (pieces the peer has, choke status, pending requests)
    ├── torrent-parser.js Torrent metadata helpers (info hash, sizes, piece/block math)
    ├── tracker.js        UDP / HTTP / HTTPS tracker clients
    └── util.js           Peer ID generation
```

## How it works

1. **Parse** the `.torrent` file with `bencode` and compute the info hash (SHA-1 of the bencoded `info` dictionary).
2. **Announce** to all supported trackers at once and merge the returned peers.
3. **Connect** to every peer over TCP and exchange handshakes. Peers with a mismatched info hash are dropped.
4. **Send `interested`** and wait for `unchoke`.
5. **Request blocks** (16 KiB each). Each peer gets up to 5 requests in flight, chosen from the pieces it advertises.
6. **Assemble pieces** in memory. When a piece is complete, check its SHA-1 against the torrent's hash. If it matches, write it to the correct file offset(s). If not, discard it and download it again.
7. **Finish** when every piece is verified.

## Configuration

There is no config file. Constants live at the top of the relevant files:

| Constant | File | Default | Meaning |
|---|---|---|---|
| `MAX_PIPELINE` | `src/download.js` | `5` | Outstanding requests per peer |
| `SOCKET_TIMEOUT` | `src/download.js` | `60000` | Idle time (ms) before a peer is dropped |
| `TICK_INTERVAL` | `src/download.js` | `5000` | How often idle peers are nudged to request more |
| `TRACKER_TIMEOUT` | `src/tracker.js` | `10000` | Per-tracker timeout (ms) |
| `LISTEN_PORT` | `src/tracker.js` | `6881` | Port reported to trackers |
| peer ID prefix | `src/util.js` | `-TR0001-` | Azureus-style client ID (`-XXVVVV-`) |

## Testing

Public swarms can be unreliable. For a controlled test, run a local tracker and seeder:

```bash
# Terminal 1: local tracker
npx bittorrent-tracker --http

# Terminal 2: create a test file, a torrent, and seed it
fsutil file createnew test.bin 20000000          # Windows; on Linux/macOS: head -c 20000000 /dev/urandom > test.bin
npx create-torrent test.bin -a http://127.0.0.1:8000/announce -o test.torrent
npx webtorrent-cli seed test.bin -a http://127.0.0.1:8000/announce

# Terminal 3: download from a different directory than the seeded file
npm start -- test.torrent
```

Flags may differ between versions of these tools. For real-world tests, use small legal torrents such as the [WebTorrent demo torrents](https://webtorrent.io/torrents/) (Sintel is multi-file).

## Limitations

- **Download only.** It never uploads, so peers have little reason to unchoke it.
- **No incoming connections.** It announces port 6881 but doesn't listen on it. Outgoing connections work fine behind NAT, but it can only reach peers that accept inbound connections.
- **No DHT, PEX, magnet links, or `wss://` (WebTorrent) trackers.** A torrent needs at least one working UDP/HTTP/HTTPS tracker.
- **No web seeds** (BEP 19 `url-list`).
- **No resume.** Files are re-created from scratch on each run, so an interrupted download starts over.
- **Single announce.** It sends `event=started` once and never re-announces or sends `completed`/`stopped`.
- **No encryption** (MSE/PE) and no rate limiting.
- **Simple piece selection.** It requests the lowest-numbered needed piece rather than rarest-first.
- **Synchronous disk writes** (`writeSync`), which is simple but not optimized for large downloads.

## Roadmap ideas

- Listen for incoming connections and upload pieces (basic seeding)
- Resume support by verifying existing data on startup
- Periodic re-announce and `completed` / `stopped` events
- Rarest-first piece selection
- Web seeds (BEP 19), which would also help with torrents like Kali's
- Magnet links and metadata exchange (BEP 9)
- DHT (BEP 5)

## Legal

Only download content you have the right to share, such as Linux distributions, public-domain media, or your own files. The author is not responsible for misuse.

## Acknowledgements

- [BitTorrent Protocol Specification (BEP 3)](https://www.bittorrent.org/beps/bep_0003.html)
- [UDP Tracker Protocol (BEP 15)](https://www.bittorrent.org/beps/bep_0015.html)
- [Compact peer lists (BEP 23)](https://www.bittorrent.org/beps/bep_0023.html)
- [bencode](https://www.npmjs.com/package/bencode) for bencoding

## License

ISC, as set in `package.json`. Add a `LICENSE` file if you publish the repo.