# Spotify Taste Graph

An interactive web app that visualizes your Spotify listening history as a force-directed graph, revealing how your artists relate to each other over time.

## Features

### Force-Directed Taste Graph
Interactive network graph where nodes are artists (sized by PageRank, colored by community cluster, showing artist photos) and edges represent co-listening sessions. Hover for mood fingerprints, click to explore connections.

### Listening Timeline
Streamgraph showing your top 10 artists' relative listening share over the last 30 daily snapshots. Reveals your musical "phases."

### Mood Landscape
2D scatter plot mapping artists by valence (sad→happy) vs energy (chill→intense). See where you actually live emotionally in music, with quadrant labels and your top artists annotated.

### Taste DNA
Radar chart comparing your short-term vs long-term audio fingerprint across energy, valence, danceability, acousticness, instrumentalness, and speechiness. Includes a generated taste summary.

## Tech Stack
- **Backend:** Python, FastAPI, networkx, python-louvain, spotipy
- **Frontend:** Vanilla JS, D3.js v7
- **Scheduling:** APScheduler (24h auto-refresh)
- **Deployment:** macOS launchd for always-on service

## Quick Start
```bash
pip install fastapi uvicorn spotipy networkx python-louvain python-dotenv requests apscheduler
python app.py
```

First run opens Spotify OAuth in your browser. After auth, the dashboard loads at http://127.0.0.1:8888.

## Persistent Service (launchd)
```bash
cp com.williamcalhoun.spotify-taste-graph.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.williamcalhoun.spotify-taste-graph.plist
```

See [SETUP.md](SETUP.md) for full details on logs, stopping/starting, and configuration.

## API Endpoints
- `GET /api/graph` — current graph data + analytics
- `GET /api/history` — historical snapshots for timeline
- `POST /api/refresh` — trigger manual data refresh
