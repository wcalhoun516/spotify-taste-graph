"""Spotify Taste Graph — FastAPI backend with OAuth, data pipeline, and graph analytics."""

import json
import os
import sys
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Thread

import networkx as nx
import requests
import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler
from community import community_louvain
from dotenv import load_dotenv, set_key
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
DATA_DIR = BASE_DIR / "data"
HISTORY_DIR = DATA_DIR / "history"
GRAPH_JSON = DATA_DIR / "graph.json"
PUBLIC_DIR = BASE_DIR / "public"

load_dotenv(ENV_PATH)

CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
ACCESS_TOKEN = os.getenv("SPOTIFY_ACCESS_TOKEN", "")
REFRESH_TOKEN = os.getenv("SPOTIFY_REFRESH_TOKEN", "")

SCOPES = "user-read-recently-played user-top-read user-read-playback-state"
AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"

MAX_SNAPSHOTS = 30
SESSION_GAP_MINUTES = 45

# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

def _persist_tokens(access: str, refresh: str):
    global ACCESS_TOKEN, REFRESH_TOKEN
    ACCESS_TOKEN = access
    REFRESH_TOKEN = refresh
    set_key(str(ENV_PATH), "SPOTIFY_ACCESS_TOKEN", access)
    if refresh:
        set_key(str(ENV_PATH), "SPOTIFY_REFRESH_TOKEN", refresh)


def refresh_access_token() -> str:
    """Use refresh token to get a new access token silently."""
    resp = requests.post(TOKEN_URL, data={
        "grant_type": "refresh_token",
        "refresh_token": REFRESH_TOKEN,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    _persist_tokens(data["access_token"], data.get("refresh_token", REFRESH_TOKEN))
    return ACCESS_TOKEN


def api_get(endpoint: str, params: dict | None = None, retries: int = 1) -> dict:
    """GET from Spotify API with automatic token refresh."""
    global ACCESS_TOKEN
    url = endpoint if endpoint.startswith("http") else f"{API_BASE}/{endpoint}"
    for attempt in range(retries + 1):
        headers = {"Authorization": f"Bearer {ACCESS_TOKEN}"}
        resp = requests.get(url, headers=headers, params=params, timeout=20)
        if resp.status_code == 401 and attempt < retries:
            ACCESS_TOKEN = refresh_access_token()
            continue
        resp.raise_for_status()
        return resp.json()
    return {}

# ---------------------------------------------------------------------------
# Data pipeline
# ---------------------------------------------------------------------------

def fetch_recently_played() -> list[dict]:
    """Paginate through recently played tracks (max ~50 per request, API limit)."""
    items = []
    params = {"limit": 50}
    for _ in range(5):  # Spotify only returns ~50 most recent regardless
        data = api_get("me/player/recently-played", params)
        batch = data.get("items", [])
        if not batch:
            break
        items.extend(batch)
        cursors = data.get("cursors")
        if not cursors or not cursors.get("before"):
            break
        params = {"limit": 50, "before": cursors["before"]}
    return items


def fetch_top_artists(time_range: str) -> list[dict]:
    """Fetch top artists for a given time range."""
    items = []
    for offset in range(0, 100, 50):
        data = api_get("me/top/artists", {"time_range": time_range, "limit": 50, "offset": offset})
        batch = data.get("items", [])
        items.extend(batch)
        if len(batch) < 50:
            break
    return items


def fetch_top_tracks_for_artist(artist_id: str) -> list[dict]:
    """Fetch an artist's top tracks."""
    data = api_get(f"artists/{artist_id}/top-tracks", {"market": "US"})
    return data.get("tracks", [])


def fetch_audio_features(track_ids: list[str]) -> list[dict]:
    """Fetch audio features for up to 100 tracks at a time."""
    features = []
    for i in range(0, len(track_ids), 100):
        chunk = track_ids[i:i+100]
        data = api_get("audio-features", {"ids": ",".join(chunk)})
        batch = data.get("audio_features", [])
        features.extend([f for f in batch if f])
    return features


def build_artist_data() -> dict:
    """Collect all artist data across time ranges + audio features."""
    all_artists: dict[str, dict] = {}  # id -> artist data
    time_range_lists: dict[str, list[str]] = {}  # time_range -> [artist_ids]

    for tr in ("short_term", "medium_term", "long_term"):
        artists = fetch_top_artists(tr)
        time_range_lists[tr] = []
        for a in artists:
            aid = a["id"]
            time_range_lists[tr].append(aid)
            if aid not in all_artists:
                all_artists[aid] = {
                    "id": aid,
                    "name": a["name"],
                    "genres": a.get("genres", []),
                    "image": a["images"][0]["url"] if a.get("images") else "",
                    "popularity": a.get("popularity", 0),
                    "followers": a.get("followers", {}).get("total", 0),
                    "audio_features": {},
                    "time_ranges": [],
                }
            all_artists[aid]["time_ranges"].append(tr)

    # Fetch audio features for each artist via their top tracks
    print(f"  Fetching audio features for {len(all_artists)} artists...")
    for aid, adata in all_artists.items():
        try:
            tracks = fetch_top_tracks_for_artist(aid)
            tids = [t["id"] for t in tracks[:10]]
            if tids:
                feats = fetch_audio_features(tids)
                if feats:
                    avg = {}
                    keys = ["energy", "valence", "danceability", "acousticness",
                            "instrumentalness", "speechiness", "tempo"]
                    for k in keys:
                        vals = [f[k] for f in feats if k in f]
                        avg[k] = round(sum(vals) / len(vals), 4) if vals else 0
                    adata["audio_features"] = avg
        except Exception as e:
            print(f"  Warning: couldn't fetch features for {adata['name']}: {e}")
        time.sleep(0.05)  # gentle rate limiting

    return {"artists": all_artists, "time_ranges": time_range_lists}


def build_co_occurrence_graph(recently_played: list[dict], artists: dict) -> dict:
    """Build co-occurrence edges from listening sessions."""
    # Extract (artist_id, played_at) pairs
    plays = []
    for item in recently_played:
        track = item.get("track", {})
        played_at = item.get("played_at", "")
        for art in track.get("artists", []):
            plays.append((art["id"], played_at))

    # Sort by time
    plays.sort(key=lambda x: x[1])

    # Build edges: artists within 45 minutes of each other
    edges: dict[tuple, int] = {}
    for i in range(len(plays)):
        for j in range(i + 1, len(plays)):
            t1 = datetime.fromisoformat(plays[i][1].replace("Z", "+00:00"))
            t2 = datetime.fromisoformat(plays[j][1].replace("Z", "+00:00"))
            gap = abs((t2 - t1).total_seconds()) / 60
            if gap > SESSION_GAP_MINUTES:
                break
            a1, a2 = plays[i][0], plays[j][0]
            if a1 != a2:
                key = tuple(sorted([a1, a2]))
                edges[key] = edges.get(key, 0) + 1

    # Estimate listening time per artist (count * ~3.5 min avg track)
    artist_play_counts: dict[str, int] = {}
    for item in recently_played:
        track = item.get("track", {})
        duration_ms = track.get("duration_ms", 210000)
        for art in track.get("artists", []):
            aid = art["id"]
            artist_play_counts[aid] = artist_play_counts.get(aid, 0) + 1

    # Convert to lists
    edge_list = [{"source": e[0], "target": e[1], "weight": w} for e, w in edges.items()]
    node_play_time = {aid: count * 3.5 for aid, count in artist_play_counts.items()}

    return {"edges": edge_list, "play_time": node_play_time}


def run_graph_analytics(artists: dict, edges: list[dict], play_time: dict) -> dict:
    """Run networkx analytics on the graph."""
    G = nx.Graph()

    # Add all artist nodes
    for aid in artists:
        G.add_node(aid)

    # Add edges
    for e in edges:
        if e["source"] in artists and e["target"] in artists:
            G.add_edge(e["source"], e["target"], weight=e["weight"])

    # Community detection (Louvain)
    if len(G.edges) > 0:
        partition = community_louvain.best_partition(G, random_state=42)
    else:
        partition = {n: 0 for n in G.nodes}

    # Betweenness centrality
    if len(G.edges) > 0:
        betweenness = nx.betweenness_centrality(G, weight="weight")
    else:
        betweenness = {n: 0 for n in G.nodes}

    # PageRank
    if len(G.edges) > 0:
        pagerank = nx.pagerank(G, weight="weight")
    else:
        pagerank = {n: 1.0 / max(len(G.nodes), 1) for n in G.nodes}

    # Average shortest path (taste diversity)
    try:
        if nx.is_connected(G) and len(G.nodes) > 1:
            avg_path = round(nx.average_shortest_path_length(G), 3)
        else:
            # Use largest connected component
            components = list(nx.connected_components(G))
            if components:
                largest = max(components, key=len)
                sub = G.subgraph(largest)
                if len(sub.nodes) > 1:
                    avg_path = round(nx.average_shortest_path_length(sub), 3)
                else:
                    avg_path = 0
            else:
                avg_path = 0
    except Exception:
        avg_path = 0

    # Cluster audio feature averages (mood fingerprint)
    clusters: dict[int, list[str]] = {}
    for aid, cid in partition.items():
        clusters.setdefault(cid, []).append(aid)

    cluster_moods = {}
    feature_keys = ["energy", "valence", "danceability", "acousticness",
                    "instrumentalness", "speechiness"]
    for cid, members in clusters.items():
        mood = {}
        for k in feature_keys:
            vals = [artists[m]["audio_features"].get(k, 0) for m in members
                    if m in artists and artists[m].get("audio_features")]
            mood[k] = round(sum(vals) / len(vals), 4) if vals else 0
        cluster_moods[str(cid)] = mood

    return {
        "communities": {aid: cid for aid, cid in partition.items()},
        "betweenness": {aid: round(v, 6) for aid, v in betweenness.items()},
        "pagerank": {aid: round(v, 6) for aid, v in pagerank.items()},
        "avg_path_length": avg_path,
        "cluster_moods": cluster_moods,
        "num_clusters": len(clusters),
    }


def generate_taste_summary(artist_data: dict, analytics: dict) -> dict:
    """Generate taste summaries comparing short vs long term features."""
    summaries = {}
    feature_keys = ["energy", "valence", "danceability", "acousticness",
                    "instrumentalness", "speechiness"]

    for tr in ("short_term", "long_term"):
        aids = artist_data["time_ranges"].get(tr, [])
        avg = {}
        for k in feature_keys:
            vals = [artist_data["artists"][a]["audio_features"].get(k, 0)
                    for a in aids if a in artist_data["artists"]
                    and artist_data["artists"][a].get("audio_features")]
            avg[k] = round(sum(vals) / len(vals), 4) if vals else 0
        summaries[tr] = avg

    # Generate text summary
    short = summaries.get("short_term", {})
    long = summaries.get("long_term", {})

    parts = []
    dominant = max(feature_keys, key=lambda k: short.get(k, 0)) if short else "energy"
    parts.append(f"Your recent listening skews high-{dominant}")

    shifts = []
    for k in feature_keys:
        diff = short.get(k, 0) - long.get(k, 0)
        if abs(diff) > 0.05:
            direction = "toward" if diff > 0 else "away from"
            shifts.append(f"a notable shift {direction} {k}")
    if shifts:
        parts.append(f"with {shifts[0]} vs. your long-term average")

    text = ", ".join(parts) + "."
    summaries["text"] = text
    return summaries


def run_full_pipeline():
    """Execute the full data pipeline and save results."""
    print(f"[{datetime.now().isoformat()}] Starting full pipeline refresh...")

    # Ensure tokens are valid
    if not ACCESS_TOKEN:
        print("  No access token — skipping pipeline (need OAuth first)")
        return
    try:
        refresh_access_token()
    except Exception as e:
        print(f"  Token refresh failed: {e}")
        return

    # 1. Fetch data
    print("  Fetching recently played...")
    recently_played = fetch_recently_played()
    print(f"  Got {len(recently_played)} recent plays")

    print("  Fetching top artists...")
    artist_data = build_artist_data()
    print(f"  Got {len(artist_data['artists'])} unique artists")

    # 2. Build co-occurrence graph
    print("  Building co-occurrence graph...")
    cooccurrence = build_co_occurrence_graph(recently_played, artist_data["artists"])
    print(f"  Got {len(cooccurrence['edges'])} edges")

    # 3. Run analytics
    print("  Running graph analytics...")
    analytics = run_graph_analytics(
        artist_data["artists"],
        cooccurrence["edges"],
        cooccurrence["play_time"]
    )
    print(f"  Detected {analytics['num_clusters']} clusters")

    # 4. Generate taste summary
    taste_summary = generate_taste_summary(artist_data, analytics)

    # 5. Build final graph.json
    nodes = []
    for aid, adata in artist_data["artists"].items():
        nodes.append({
            "id": aid,
            "name": adata["name"],
            "genres": adata["genres"],
            "image": adata["image"],
            "popularity": adata["popularity"],
            "followers": adata["followers"],
            "audio_features": adata["audio_features"],
            "time_ranges": adata["time_ranges"],
            "community": analytics["communities"].get(aid, 0),
            "betweenness": analytics["betweenness"].get(aid, 0),
            "pagerank": analytics["pagerank"].get(aid, 0),
            "play_time": cooccurrence["play_time"].get(aid, 0),
        })

    # Top 5 artists by play time
    top5 = sorted(nodes, key=lambda n: n["play_time"], reverse=True)[:5]

    # Bridge artist (highest betweenness)
    bridge = max(nodes, key=lambda n: n["betweenness"]) if nodes else None

    graph_data = {
        "nodes": nodes,
        "edges": cooccurrence["edges"],
        "analytics": {
            "num_clusters": analytics["num_clusters"],
            "cluster_moods": analytics["cluster_moods"],
            "avg_path_length": analytics["avg_path_length"],
            "taste_summary": taste_summary,
        },
        "stats": {
            "top5": [{"id": a["id"], "name": a["name"], "play_time": a["play_time"]} for a in top5],
            "bridge_artist": {"id": bridge["id"], "name": bridge["name"],
                              "betweenness": bridge["betweenness"]} if bridge else None,
            "num_clusters": analytics["num_clusters"],
            "diversity_score": analytics["avg_path_length"],
        },
        "time_ranges": {tr: aids for tr, aids in artist_data["time_ranges"].items()},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    # 6. Save
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    with open(GRAPH_JSON, "w") as f:
        json.dump(graph_data, f, indent=2)

    # Snapshot
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    snapshot_path = HISTORY_DIR / f"graph_{ts}.json"
    with open(snapshot_path, "w") as f:
        json.dump(graph_data, f)

    # Prune old snapshots
    snapshots = sorted(HISTORY_DIR.glob("graph_*.json"))
    while len(snapshots) > MAX_SNAPSHOTS:
        snapshots[0].unlink()
        snapshots.pop(0)

    print(f"  Pipeline complete. Saved to {GRAPH_JSON}")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Spotify Taste Graph")


@app.get("/callback")
async def oauth_callback(code: str = "", error: str = ""):
    """Handle Spotify OAuth callback."""
    if error:
        return JSONResponse({"error": error}, status_code=400)
    if not code:
        return JSONResponse({"error": "no code"}, status_code=400)

    # Exchange code for tokens
    resp = requests.post(TOKEN_URL, data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    _persist_tokens(data["access_token"], data.get("refresh_token", ""))
    print("  OAuth tokens received and saved.")

    # Kick off pipeline in background
    Thread(target=run_full_pipeline, daemon=True).start()

    return RedirectResponse("/")


@app.get("/api/graph")
async def get_graph():
    """Serve the current graph data."""
    if GRAPH_JSON.exists():
        with open(GRAPH_JSON) as f:
            return JSONResponse(json.load(f))
    return JSONResponse({"nodes": [], "edges": [], "analytics": {}, "stats": {},
                         "time_ranges": {}, "updated_at": None})


@app.get("/api/history")
async def get_history():
    """Serve list of historical snapshots for the timeline view."""
    snapshots = []
    for p in sorted(HISTORY_DIR.glob("graph_*.json")):
        try:
            with open(p) as f:
                data = json.load(f)
            snapshots.append(data)
        except Exception:
            pass
    return JSONResponse(snapshots)


@app.post("/api/refresh")
async def trigger_refresh():
    """Manually trigger a pipeline refresh."""
    Thread(target=run_full_pipeline, daemon=True).start()
    return JSONResponse({"status": "refresh started"})


# Serve frontend
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def start_server():
    """Start uvicorn server."""
    uvicorn.run(app, host="127.0.0.1", port=8888, log_level="info")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    needs_auth = not REFRESH_TOKEN

    # Schedule 24h refresh
    scheduler = BackgroundScheduler()
    scheduler.add_job(run_full_pipeline, "interval", hours=24, id="daily_refresh",
                      next_run_time=None)  # Don't run immediately — we do it manually below
    scheduler.start()

    if needs_auth:
        # First run: open browser to OAuth
        auth_params = (
            f"?client_id={CLIENT_ID}"
            f"&response_type=code"
            f"&redirect_uri={REDIRECT_URI}"
            f"&scope={SCOPES.replace(' ', '%20')}"
            f"&show_dialog=true"
        )
        auth_full_url = AUTH_URL + auth_params
        print(f"Opening browser for Spotify authorization...")
        print(f"  URL: {auth_full_url}")

        # Start server first so callback works
        server_thread = Thread(target=start_server, daemon=True)
        server_thread.start()
        time.sleep(1)

        webbrowser.open(auth_full_url)
        print("Waiting for OAuth callback...")
        # Keep main thread alive
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            scheduler.shutdown()
    else:
        # Subsequent run: refresh token, run pipeline, open browser
        print("Found existing refresh token. Starting silently...")

        # Start server
        server_thread = Thread(target=start_server, daemon=True)
        server_thread.start()
        time.sleep(1)

        # Run pipeline if no cached data or data is old
        if not GRAPH_JSON.exists():
            run_full_pipeline()
        else:
            # Check age
            try:
                with open(GRAPH_JSON) as f:
                    data = json.load(f)
                updated = data.get("updated_at", "")
                if updated:
                    dt = datetime.fromisoformat(updated)
                    age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
                    if age_hours > 24:
                        run_full_pipeline()
                    else:
                        print(f"  Using cached data ({age_hours:.1f}h old)")
                else:
                    run_full_pipeline()
            except Exception:
                run_full_pipeline()

        webbrowser.open("http://127.0.0.1:8888")

        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            scheduler.shutdown()


if __name__ == "__main__":
    main()
