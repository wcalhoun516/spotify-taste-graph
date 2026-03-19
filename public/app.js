/* Spotify Taste Graph — Frontend (D3.js v7) */

const COLORS = [
  "#1DB954", "#E84855", "#5B8DEE", "#FFB347", "#C77DFF",
  "#2EC4B6", "#FF6B6B", "#48BFE3", "#F7C948", "#EE6C9F",
  "#72EFDD", "#FF9F1C", "#9B5DE5", "#00F5D4", "#FEE440"
];

let graphData = null;
let historyData = null;
let simulation = null;
let selectedCluster = null;

// -------------------------------------------------------------------------
// Init
// -------------------------------------------------------------------------
async function init() {
  graphData = await fetch("/api/graph").then(r => r.json());
  updateSidebar();
  setupTabs();
  renderGraph();
  // Lazy-load other views on tab switch
}

// -------------------------------------------------------------------------
// Tabs
// -------------------------------------------------------------------------
function setupTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      btn.classList.add("active");
      const view = document.getElementById(`view-${btn.dataset.tab}`);
      view.classList.add("active");
      // Render on first switch
      if (btn.dataset.tab === "timeline" && !view.dataset.rendered) {
        loadAndRenderTimeline();
        view.dataset.rendered = "1";
      }
      if (btn.dataset.tab === "mood" && !view.dataset.rendered) {
        renderMoodMap();
        view.dataset.rendered = "1";
      }
      if (btn.dataset.tab === "dna" && !view.dataset.rendered) {
        renderTasteDNA();
        view.dataset.rendered = "1";
      }
    });
  });
}

// -------------------------------------------------------------------------
// Sidebar
// -------------------------------------------------------------------------
function updateSidebar() {
  if (!graphData || !graphData.stats) return;
  const s = graphData.stats;

  const top5El = document.getElementById("stat-top5");
  top5El.innerHTML = "";
  (s.top5 || []).forEach((a, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${i + 1}. ${a.name}</span><span class="time">${Math.round(a.play_time)}m</span>`;
    top5El.appendChild(li);
  });

  document.getElementById("stat-clusters").textContent = s.num_clusters || "—";
  document.getElementById("stat-bridge").textContent = s.bridge_artist ? s.bridge_artist.name : "—";
  document.getElementById("stat-diversity").textContent = s.diversity_score ? s.diversity_score.toFixed(2) : "—";

  if (graphData.updated_at) {
    const d = new Date(graphData.updated_at);
    document.getElementById("stat-updated").textContent = d.toLocaleString();
  }
}

function triggerRefresh() {
  const btn = document.getElementById("refresh-btn");
  btn.textContent = "Refreshing...";
  btn.disabled = true;
  fetch("/api/refresh", { method: "POST" }).then(() => {
    setTimeout(() => {
      location.reload();
    }, 30000); // Reload after 30s to get new data
  });
}

// -------------------------------------------------------------------------
// Artist card
// -------------------------------------------------------------------------
function showArtistCard(node) {
  const card = document.getElementById("artist-card");
  card.classList.remove("hidden");
  document.getElementById("card-image").src = node.image || "";
  document.getElementById("card-name").textContent = node.name;

  const genresEl = document.getElementById("card-genres");
  genresEl.innerHTML = "";
  (node.genres || []).slice(0, 5).forEach(g => {
    const span = document.createElement("span");
    span.textContent = g;
    genresEl.appendChild(span);
  });

  document.getElementById("card-stats").innerHTML =
    `Popularity: ${node.popularity}<br>` +
    `PageRank: ${(node.pagerank * 1000).toFixed(1)}<br>` +
    `Centrality: ${(node.betweenness * 100).toFixed(2)}%<br>` +
    `Play time: ~${Math.round(node.play_time)}min`;

  drawRadarCanvas(node.audio_features);
}

function closeArtistCard() {
  document.getElementById("artist-card").classList.add("hidden");
}

function drawRadarCanvas(features) {
  const canvas = document.getElementById("card-radar");
  const ctx = canvas.getContext("2d");
  const w = 200, h = 200, cx = w / 2, cy = h / 2, r = 70;
  ctx.clearRect(0, 0, w, h);

  const keys = ["energy", "valence", "danceability", "acousticness", "instrumentalness", "speechiness"];
  const n = keys.length;
  const angleStep = (Math.PI * 2) / n;

  // Grid
  [0.25, 0.5, 0.75, 1].forEach(level => {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = i * angleStep - Math.PI / 2;
      const x = cx + Math.cos(a) * r * level;
      const y = cy + Math.sin(a) * r * level;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.stroke();
  });

  // Labels
  ctx.fillStyle = "#888";
  ctx.font = "9px Inter, sans-serif";
  ctx.textAlign = "center";
  keys.forEach((k, i) => {
    const a = i * angleStep - Math.PI / 2;
    const x = cx + Math.cos(a) * (r + 18);
    const y = cy + Math.sin(a) * (r + 18);
    ctx.fillText(k.slice(0, 5), x, y + 3);
  });

  if (!features) return;

  // Data polygon
  ctx.beginPath();
  keys.forEach((k, i) => {
    const val = features[k] || 0;
    const a = i * angleStep - Math.PI / 2;
    const x = cx + Math.cos(a) * r * val;
    const y = cy + Math.sin(a) * r * val;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(29, 185, 84, 0.25)";
  ctx.fill();
  ctx.strokeStyle = "#1DB954";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Dots
  keys.forEach((k, i) => {
    const val = features[k] || 0;
    const a = i * angleStep - Math.PI / 2;
    const x = cx + Math.cos(a) * r * val;
    const y = cy + Math.sin(a) * r * val;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#1DB954";
    ctx.fill();
  });
}

// -------------------------------------------------------------------------
// VIZ 1: Force-Directed Graph
// -------------------------------------------------------------------------
function renderGraph() {
  if (!graphData || !graphData.nodes || graphData.nodes.length === 0) return;

  const container = document.getElementById("view-graph");
  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();

  const width = container.clientWidth;
  const height = container.clientHeight;
  svg.attr("viewBox", [0, 0, width, height]);

  const timeRange = document.getElementById("time-range-select").value;
  const minEdge = +document.getElementById("edge-slider").value;

  // Filter nodes by time range
  let nodes = graphData.nodes;
  if (timeRange !== "all") {
    const ids = new Set(graphData.time_ranges[timeRange] || []);
    nodes = nodes.filter(n => ids.has(n.id));
  }
  const nodeIds = new Set(nodes.map(n => n.id));

  // Filter edges
  let edges = graphData.edges.filter(e =>
    e.weight >= minEdge && nodeIds.has(e.source) && nodeIds.has(e.target)
  );

  // Deep copy for simulation
  const simNodes = nodes.map(d => ({ ...d }));
  const simEdges = edges.map(d => ({ ...d }));

  // Scales
  const prMax = d3.max(simNodes, d => d.pagerank) || 1;
  const rScale = d3.scaleSqrt().domain([0, prMax]).range([8, 40]);
  const ewMax = d3.max(simEdges, d => d.weight) || 1;
  const ewScale = d3.scaleLinear().domain([1, ewMax]).range([0.5, 4]);

  // Zoom
  const g = svg.append("g");
  const zoom = d3.zoom().scaleExtent([0.2, 5]).on("zoom", e => g.attr("transform", e.transform));
  svg.call(zoom);

  // Simulation
  simulation = d3.forceSimulation(simNodes)
    .force("link", d3.forceLink(simEdges).id(d => d.id).distance(120).strength(d => d.weight / ewMax * 0.3))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => rScale(d.pagerank) + 4));

  // Edges
  const link = g.append("g")
    .selectAll("line")
    .data(simEdges)
    .join("line")
    .attr("stroke", "rgba(255,255,255,0.08)")
    .attr("stroke-width", d => ewScale(d.weight));

  // Defs for clip circles
  const defs = svg.append("defs");

  // Node groups
  const node = g.append("g")
    .selectAll("g")
    .data(simNodes)
    .join("g")
    .attr("cursor", "pointer")
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  // Clip paths
  node.each(function(d) {
    const r = rScale(d.pagerank);
    defs.append("clipPath")
      .attr("id", `clip-${d.id}`)
      .append("circle")
      .attr("r", r);
  });

  // Circle backgrounds
  node.append("circle")
    .attr("r", d => rScale(d.pagerank))
    .attr("fill", d => COLORS[d.community % COLORS.length])
    .attr("stroke", d => COLORS[d.community % COLORS.length])
    .attr("stroke-width", 2)
    .attr("opacity", 0.9);

  // Artist images
  node.append("image")
    .attr("href", d => d.image)
    .attr("x", d => -rScale(d.pagerank))
    .attr("y", d => -rScale(d.pagerank))
    .attr("width", d => rScale(d.pagerank) * 2)
    .attr("height", d => rScale(d.pagerank) * 2)
    .attr("clip-path", d => `url(#clip-${d.id})`)
    .attr("preserveAspectRatio", "xMidYMid slice");

  // Tooltip
  const tooltip = document.getElementById("tooltip");
  node.on("mouseover", (e, d) => {
    const feats = d.audio_features || {};
    const featStr = Object.entries(feats)
      .filter(([k]) => k !== "tempo")
      .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`)
      .join(", ");
    tooltip.innerHTML =
      `<div class="tooltip-name">${d.name}</div>` +
      `<div class="tooltip-genres">${(d.genres || []).slice(0, 3).join(", ")}</div>` +
      `<div class="tooltip-stat">Play time: ~${Math.round(d.play_time)}min</div>` +
      `<div class="tooltip-stat">PageRank: ${(d.pagerank * 1000).toFixed(1)}</div>` +
      `<div class="tooltip-stat" style="margin-top:4px;font-size:10px">${featStr}</div>`;
    tooltip.classList.remove("hidden");
    tooltip.style.left = (e.pageX + 14) + "px";
    tooltip.style.top = (e.pageY - 10) + "px";
  }).on("mousemove", e => {
    tooltip.style.left = (e.pageX + 14) + "px";
    tooltip.style.top = (e.pageY - 10) + "px";
  }).on("mouseout", () => {
    tooltip.classList.add("hidden");
  }).on("click", (e, d) => {
    showArtistCard(d);
    highlightConnections(d, simEdges, node, link);
  });

  // Cluster labels
  const clusters = {};
  simNodes.forEach(n => {
    const c = n.community;
    if (!clusters[c]) clusters[c] = [];
    clusters[c].push(n);
  });

  const clusterLabels = g.append("g").selectAll("text")
    .data(Object.entries(clusters).filter(([, arr]) => arr.length >= 2))
    .join("text")
    .attr("class", "cluster-label")
    .text(([cid]) => {
      const moods = graphData.analytics?.cluster_moods?.[cid] || {};
      const top = Object.entries(moods).sort((a, b) => b[1] - a[1])[0];
      return top ? top[0] : `Cluster ${cid}`;
    });

  // Tick
  simulation.on("tick", () => {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
    clusterLabels.attr("x", ([, arr]) => d3.mean(arr, n => n.x))
      .attr("y", ([, arr]) => d3.mean(arr, n => n.y) - 30);
  });

  // Controls
  document.getElementById("time-range-select").onchange = renderGraph;
  document.getElementById("edge-slider").oninput = function() {
    document.getElementById("edge-slider-val").textContent = this.value;
    renderGraph();
  };
  document.getElementById("isolate-cluster").onchange = function() {
    if (this.checked && selectedCluster !== null) {
      renderGraph();
    }
  };
}

function highlightConnections(d, edges, nodeSelection, linkSelection) {
  const connected = new Set();
  edges.forEach(e => {
    const src = typeof e.source === "object" ? e.source.id : e.source;
    const tgt = typeof e.target === "object" ? e.target.id : e.target;
    if (src === d.id) connected.add(tgt);
    if (tgt === d.id) connected.add(src);
  });
  connected.add(d.id);

  nodeSelection.select("circle")
    .transition().duration(300)
    .attr("opacity", n => connected.has(n.id) ? 1 : 0.1);
  nodeSelection.select("image")
    .transition().duration(300)
    .attr("opacity", n => connected.has(n.id) ? 1 : 0.05);
  linkSelection.transition().duration(300)
    .attr("stroke", e => {
      const src = typeof e.source === "object" ? e.source.id : e.source;
      const tgt = typeof e.target === "object" ? e.target.id : e.target;
      return (src === d.id || tgt === d.id) ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.02)";
    });

  // Click on background to reset
  d3.select("#graph-svg").on("click.reset", function(e) {
    if (e.target === this) {
      nodeSelection.select("circle").transition().duration(300).attr("opacity", 0.9);
      nodeSelection.select("image").transition().duration(300).attr("opacity", 1);
      linkSelection.transition().duration(300).attr("stroke", "rgba(255,255,255,0.08)");
      d3.select("#graph-svg").on("click.reset", null);
    }
  });
}

// -------------------------------------------------------------------------
// VIZ 2: Listening Timeline (Streamgraph)
// -------------------------------------------------------------------------
async function loadAndRenderTimeline() {
  historyData = await fetch("/api/history").then(r => r.json());
  if (!historyData || historyData.length < 2) {
    const svg = d3.select("#timeline-svg");
    svg.selectAll("*").remove();
    svg.append("text")
      .attr("x", 40).attr("y", 60)
      .attr("fill", "#888").attr("font-size", "15px")
      .text("Waiting for more snapshots to build your timeline...");
    svg.append("text")
      .attr("x", 40).attr("y", 88)
      .attr("fill", "#555").attr("font-size", "13px")
      .text(`You have ${historyData ? historyData.length : 0} snapshot(s). The streamgraph needs at least 2 daily snapshots.`);
    svg.append("text")
      .attr("x", 40).attr("y", 112)
      .attr("fill", "#555").attr("font-size", "13px")
      .text("The app saves a new snapshot every 24 hours — check back tomorrow!");
    return;
  }
  renderTimeline();
}

function renderTimeline() {
  const container = document.getElementById("view-timeline");
  const svg = d3.select("#timeline-svg");
  svg.selectAll("*").remove();

  const margin = { top: 20, right: 30, bottom: 40, left: 50 };
  const width = container.clientWidth - margin.left - margin.right;
  const height = container.clientHeight - 120 - margin.top - margin.bottom;

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // Collect top 10 artists across all snapshots by play time
  const artistTime = {};
  historyData.forEach(snap => {
    (snap.nodes || []).forEach(n => {
      artistTime[n.id] = (artistTime[n.id] || 0) + (n.play_time || 0);
    });
  });
  const top10Ids = Object.entries(artistTime)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);

  // Artist name lookup
  const nameMap = {};
  const communityMap = {};
  historyData.forEach(snap => {
    (snap.nodes || []).forEach(n => {
      nameMap[n.id] = n.name;
      communityMap[n.id] = n.community || 0;
    });
  });

  // Build data series
  const series = historyData.map((snap, i) => {
    const row = { date: snap.updated_at ? new Date(snap.updated_at) : new Date(Date.now() - (historyData.length - i) * 86400000) };
    const total = top10Ids.reduce((s, id) => {
      const node = (snap.nodes || []).find(n => n.id === id);
      return s + (node ? node.play_time || 0 : 0);
    }, 0) || 1;
    top10Ids.forEach(id => {
      const node = (snap.nodes || []).find(n => n.id === id);
      row[id] = (node ? (node.play_time || 0) / total : 0);
    });
    return row;
  });

  const stack = d3.stack().keys(top10Ids).offset(d3.stackOffsetWiggle);
  const layers = stack(series);

  const x = d3.scaleTime()
    .domain(d3.extent(series, d => d.date))
    .range([0, width]);

  const y = d3.scaleLinear()
    .domain([d3.min(layers, l => d3.min(l, d => d[0])), d3.max(layers, l => d3.max(l, d => d[1]))])
    .range([height, 0]);

  const area = d3.area()
    .x(d => x(d.data.date))
    .y0(d => y(d[0]))
    .y1(d => y(d[1]))
    .curve(d3.curveBasis);

  const tooltip = document.getElementById("timeline-tooltip");

  g.selectAll("path")
    .data(layers)
    .join("path")
    .attr("d", area)
    .attr("fill", (d, i) => COLORS[communityMap[top10Ids[i]] % COLORS.length])
    .attr("opacity", 0.8)
    .on("mouseover", (e, d) => {
      const name = nameMap[d.key] || d.key;
      tooltip.innerHTML = `<div class="tooltip-name">${name}</div>`;
      tooltip.classList.remove("hidden");
    })
    .on("mousemove", e => {
      tooltip.style.left = (e.pageX + 14) + "px";
      tooltip.style.top = (e.pageY - 10) + "px";
    })
    .on("mouseout", () => tooltip.classList.add("hidden"));

  // X axis
  g.append("g")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x).ticks(6))
    .selectAll("text").attr("fill", "#888");
  g.selectAll(".domain, .tick line").attr("stroke", "#333");

  // Legend
  const legend = g.append("g").attr("transform", `translate(${width - 160}, 10)`);
  top10Ids.forEach((id, i) => {
    const row = legend.append("g").attr("transform", `translate(0, ${i * 16})`);
    row.append("rect").attr("width", 10).attr("height", 10).attr("rx", 2)
      .attr("fill", COLORS[communityMap[id] % COLORS.length]);
    row.append("text").attr("x", 14).attr("y", 9).attr("fill", "#ccc")
      .attr("font-size", "10px").text(nameMap[id] || id);
  });
}

// -------------------------------------------------------------------------
// VIZ 3: Mood Landscape (Scatter)
// -------------------------------------------------------------------------
function renderMoodMap() {
  if (!graphData || !graphData.nodes) return;

  const container = document.getElementById("view-mood");
  const svg = d3.select("#mood-svg");
  svg.selectAll("*").remove();

  const margin = { top: 40, right: 40, bottom: 50, left: 60 };
  const width = container.clientWidth - margin.left - margin.right;
  const height = container.clientHeight - 100 - margin.top - margin.bottom;

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const nodes = graphData.nodes.filter(n => n.audio_features && n.audio_features.valence != null);

  const x = d3.scaleLinear().domain([0, 1]).range([0, width]);
  const y = d3.scaleLinear().domain([0, 1]).range([height, 0]);
  const ptMax = d3.max(nodes, d => d.play_time) || 1;
  const rScale = d3.scaleSqrt().domain([0, ptMax]).range([5, 30]);

  // Quadrant backgrounds
  const quads = [
    { label: "Melancholic", x: 0.25, y: 0.25 },
    { label: "Dark & Intense", x: 0.25, y: 0.75 },
    { label: "Sunny & Chill", x: 0.75, y: 0.25 },
    { label: "Euphoric", x: 0.75, y: 0.75 },
  ];
  g.selectAll(".quadrant-label")
    .data(quads)
    .join("text")
    .attr("class", "quadrant-label")
    .attr("x", d => x(d.x))
    .attr("y", d => y(d.y))
    .text(d => d.label);

  // Grid lines
  g.append("line").attr("x1", x(0.5)).attr("x2", x(0.5)).attr("y1", 0).attr("y2", height)
    .attr("stroke", "rgba(255,255,255,0.05)").attr("stroke-dasharray", "4,4");
  g.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(0.5)).attr("y2", y(0.5))
    .attr("stroke", "rgba(255,255,255,0.05)").attr("stroke-dasharray", "4,4");

  const tooltip = document.getElementById("mood-tooltip");

  // Dots
  g.selectAll("circle")
    .data(nodes)
    .join("circle")
    .attr("cx", d => x(d.audio_features.valence))
    .attr("cy", d => y(d.audio_features.energy))
    .attr("r", d => rScale(d.play_time))
    .attr("fill", d => COLORS[d.community % COLORS.length])
    .attr("opacity", 0.7)
    .attr("stroke", d => COLORS[d.community % COLORS.length])
    .attr("stroke-width", 1)
    .on("mouseover", (e, d) => {
      tooltip.innerHTML =
        `<div class="tooltip-name">${d.name}</div>` +
        `<img src="${d.image}" style="width:40px;height:40px;border-radius:50%;margin:4px 0">` +
        `<div class="tooltip-stat">Valence: ${(d.audio_features.valence * 100).toFixed(0)}%</div>` +
        `<div class="tooltip-stat">Energy: ${(d.audio_features.energy * 100).toFixed(0)}%</div>`;
      tooltip.classList.remove("hidden");
    })
    .on("mousemove", e => {
      tooltip.style.left = (e.pageX + 14) + "px";
      tooltip.style.top = (e.pageY - 10) + "px";
    })
    .on("mouseout", () => tooltip.classList.add("hidden"));

  // Top 3 labels
  const top3 = [...nodes].sort((a, b) => b.play_time - a.play_time).slice(0, 3);
  g.selectAll(".top-label")
    .data(top3)
    .join("text")
    .attr("x", d => x(d.audio_features.valence))
    .attr("y", d => y(d.audio_features.energy) - rScale(d.play_time) - 6)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .text(d => d.name);

  // Axes
  g.append("g").attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d => `${(d * 100).toFixed(0)}%`))
    .selectAll("text").attr("fill", "#888");
  g.append("g")
    .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${(d * 100).toFixed(0)}%`))
    .selectAll("text").attr("fill", "#888");
  g.selectAll(".domain, .tick line").attr("stroke", "#333");

  // Axis labels
  svg.append("text").attr("x", margin.left + width / 2).attr("y", margin.top + height + 42)
    .attr("text-anchor", "middle").attr("fill", "#888").attr("font-size", "12px")
    .text("Valence (Sad → Happy)");
  svg.append("text")
    .attr("transform", `translate(16, ${margin.top + height / 2}) rotate(-90)`)
    .attr("text-anchor", "middle").attr("fill", "#888").attr("font-size", "12px")
    .text("Energy (Chill → Intense)");
}

// -------------------------------------------------------------------------
// VIZ 4: Taste DNA (Radar)
// -------------------------------------------------------------------------
function renderTasteDNA() {
  if (!graphData || !graphData.analytics) return;

  const container = document.getElementById("view-dna");
  const svg = d3.select("#dna-svg");
  svg.selectAll("*").remove();

  const size = Math.min(container.clientWidth - 40, container.clientHeight - 200, 500);
  const cx = container.clientWidth / 2;
  const cy = size / 2 + 20;
  const radius = size / 2 - 60;

  const keys = ["energy", "valence", "danceability", "acousticness", "instrumentalness", "speechiness"];
  const n = keys.length;
  const angleStep = (Math.PI * 2) / n;

  const summary = graphData.analytics.taste_summary || {};
  const shortTerm = summary.short_term || {};
  const longTerm = summary.long_term || {};

  // Grid
  const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);
  [0.25, 0.5, 0.75, 1].forEach(level => {
    const points = keys.map((_, i) => {
      const a = i * angleStep - Math.PI / 2;
      return [Math.cos(a) * radius * level, Math.sin(a) * radius * level];
    });
    g.append("polygon")
      .attr("points", points.map(p => p.join(",")).join(" "))
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.08)");
  });

  // Axis lines + labels
  keys.forEach((k, i) => {
    const a = i * angleStep - Math.PI / 2;
    const x2 = Math.cos(a) * radius;
    const y2 = Math.sin(a) * radius;
    g.append("line").attr("x1", 0).attr("y1", 0).attr("x2", x2).attr("y2", y2)
      .attr("stroke", "rgba(255,255,255,0.05)");
    const lx = Math.cos(a) * (radius + 24);
    const ly = Math.sin(a) * (radius + 24);
    g.append("text").attr("x", lx).attr("y", ly + 4)
      .attr("text-anchor", "middle").attr("fill", "#aaa").attr("font-size", "11px")
      .attr("font-weight", "500")
      .text(k.charAt(0).toUpperCase() + k.slice(1));
  });

  // Draw polygon helper
  function drawPoly(data, color, label) {
    const points = keys.map((k, i) => {
      const val = data[k] || 0;
      const a = i * angleStep - Math.PI / 2;
      return [Math.cos(a) * radius * val, Math.sin(a) * radius * val];
    });
    g.append("polygon")
      .attr("points", points.map(p => p.join(",")).join(" "))
      .attr("fill", color.replace(")", ",0.15)").replace("rgb", "rgba"))
      .attr("stroke", color)
      .attr("stroke-width", 2);
    // Dots
    points.forEach(p => {
      g.append("circle").attr("cx", p[0]).attr("cy", p[1]).attr("r", 3).attr("fill", color);
    });
  }

  // Long term (dimmer)
  drawPoly(longTerm, "rgba(255,255,255,0.5)", "Long Term");
  // Short term (green)
  drawPoly(shortTerm, "#1DB954", "Short Term");

  // Legend
  const leg = svg.append("g").attr("transform", `translate(${cx - 80}, ${cy + radius + 40})`);
  [{ label: "Short Term", color: "#1DB954" }, { label: "Long Term", color: "rgba(255,255,255,0.5)" }].forEach((item, i) => {
    const row = leg.append("g").attr("transform", `translate(${i * 140}, 0)`);
    row.append("rect").attr("width", 12).attr("height", 12).attr("rx", 2).attr("fill", item.color);
    row.append("text").attr("x", 18).attr("y", 10).attr("fill", "#ccc").attr("font-size", "12px").text(item.label);
  });

  // Text summary
  const summaryEl = document.getElementById("taste-summary");
  summaryEl.innerHTML = `<div class="label">Taste Summary</div><p>${summary.text || "Not enough data yet."}</p>`;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------
window.addEventListener("resize", () => {
  const active = document.querySelector(".tab.active");
  if (active) {
    const tab = active.dataset.tab;
    if (tab === "graph") renderGraph();
    // Other views re-render too on resize (simplified approach)
  }
});

init();
