# Spotify Taste Graph — Setup

## Prerequisites
- Python 3.10+
- Spotify Developer app with Client ID and Secret

## Install dependencies
```bash
pip install fastapi uvicorn spotipy networkx python-louvain python-dotenv requests apscheduler
```

## Configure credentials
Edit `.env` with your Spotify app credentials:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

## First run
```bash
cd spotify-taste-graph
python app.py
```
Your browser will open for Spotify authorization. After authenticating, the app fetches your data and opens the dashboard.

## Persistent service (Mac mini, launchd)

### Install the plist
```bash
cp com.williamcalhoun.spotify-taste-graph.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.williamcalhoun.spotify-taste-graph.plist
```

### Check logs
```bash
tail -f ~/Library/Logs/spotify-taste-graph.log
```

### Stop the service
```bash
launchctl unload ~/Library/LaunchAgents/com.williamcalhoun.spotify-taste-graph.plist
```

### Start the service
```bash
launchctl load ~/Library/LaunchAgents/com.williamcalhoun.spotify-taste-graph.plist
```

### Access
The app is available at **http://127.0.0.1:8888** whenever the Mac mini is on.

## Manual refresh
Hit the "Refresh Now" button in the sidebar, or:
```bash
curl -X POST http://127.0.0.1:8888/api/refresh
```

## Data
- Current graph: `data/graph.json`
- Historical snapshots: `data/history/` (last 30 kept)
- Auto-refresh: every 24 hours via APScheduler
