import { basename } from "path";
import { open, decodeStr } from "./src/torrent-parser.js";
import download from "./src/download.js";

const torrentPath = process.argv[2];
if (!torrentPath) {
    console.error("Usage: node index.js <file.torrent>");
    process.exit(1);
}

const torrent = open(torrentPath);
download(torrent, basename(decodeStr(torrent.info.name)));
