
import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import './App.css'

const STREAM_URL = 'http://127.0.0.1:8000/hls/master.m3u8'
const SIMULATOR_URL = 'http://127.0.0.1:8000/simulated-hls'
const MAX_SEGMENT_SAMPLES = 10

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00'

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

function formatMbps(value) {
  return Number.isFinite(value) && value > 0
    ? `${value.toFixed(2)} Mbps`
    : '—'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'

  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`
}

function formatTtfb(value) {
  return Number.isFinite(value) && value >= 0
    ? `${value.toFixed(2)} ms`
    : '—'
}

function App() {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)

  const [status, setStatus] = useState('Connecting')
  const [error, setError] = useState('')
  const [levels, setLevels] = useState([])
  const [selectedQuality, setSelectedQuality] = useState('auto')
  const [activeQuality, setActiveQuality] = useState('Detecting')
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [segmentSamples, setSegmentSamples] = useState([])
  const [bufferSeconds, setBufferSeconds] = useState(0)

  // Network simulation settings
  const [networkMode, setNetworkMode] = useState('normal')
  const [simulatedBandwidth, setSimulatedBandwidth] = useState('1')

  const streamUrl = networkMode === 'simulated'
    ? `${SIMULATOR_URL}/${simulatedBandwidth}/master.m3u8`
    : STREAM_URL

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls = null

    setStatus('Connecting')
    setError('')

    function updateBuffer() {
      if (video.buffered.length === 0) {
        setBufferSeconds(0)
        return
      }

      const playbackPosition = video.currentTime

      for (let index = 0; index < video.buffered.length; index += 1) {
        const rangeStart = video.buffered.start(index)
        const rangeEnd = video.buffered.end(index)

        if (
          playbackPosition >= rangeStart &&
          playbackPosition <= rangeEnd
        ) {
          setBufferSeconds(Math.max(0, rangeEnd - playbackPosition))
          return
        }
      }

      setBufferSeconds(0)
    }

    const handlePlaying = () => {
      setPlaying(true)
      setStatus('Playing')
      updateBuffer()
    }

    const handlePause = () => {
      setPlaying(false)
      if (!video.ended) setStatus('Paused')
    }

    const handleWaiting = () => {
      setStatus('Buffering')
      updateBuffer()
    }

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime)
      updateBuffer()
    }

    const handleProgress = () => {
      updateBuffer()
    }

    const handleLoadedMetadata = () => {
      setDuration(video.duration)
    }

    const handleEnded = () => {
      setPlaying(false)
      setStatus('Finished')
      updateBuffer()
    }

    video.addEventListener('playing', handlePlaying)
    video.addEventListener('pause', handlePause)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('progress', handleProgress)
    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('ended', handleEnded)

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
      })

      hlsRef.current = hls

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(streamUrl)
      })

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const availableLevels = hls.levels.map((level, index) => ({
          index,
          height: level.height,
          bitrate: level.bitrate,
        }))

        setLevels(availableLevels)
        setStatus('Ready')
        setError('')
      })

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const level = hls.levels[data.level]

        if (level) {
          setActiveQuality(`${level.height}p`)
        }
      })

      // Collect measurements from completed video fragments.
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        const fragment = data.frag

        // Ignore audio, subtitles, and initialization fragments.
        if (fragment.type !== 'main' || fragment.sn === 'initSegment') {
          return
        }

        const stats = fragment.stats
        const downloadedBytes = stats.loaded
        const downloadDurationMs =
          stats.loading.end - stats.loading.start

        if (
          stats.aborted ||
          !Number.isFinite(downloadedBytes) ||
          downloadedBytes <= 0 ||
          !Number.isFinite(downloadDurationMs) ||
          downloadDurationMs <= 0
        ) {
          return
        }

        const throughputMbps =
          (downloadedBytes * 8) / (downloadDurationMs * 1000)

        const firstByteTime = stats.loading.first

        const ttfbMs =
          Number.isFinite(firstByteTime) &&
          firstByteTime > 0 &&
          firstByteTime >= stats.loading.start
            ? firstByteTime - stats.loading.start
            : null

        const level = hls.levels[fragment.level]

        const sample = {
          id: `${fragment.level}-${fragment.sn}-${Date.now()}`,
          quality: level ? `${level.height}p` : 'Unknown',
          bytes: downloadedBytes,
          durationSeconds: downloadDurationMs / 1000,
          throughputMbps,
          ttfbMs,
        }

        setSegmentSamples((previousSamples) =>
          [sample, ...previousSamples].slice(0, MAX_SEGMENT_SAMPLES),
        )
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setStatus('Error')

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setError(
              'Network error while loading the video. Check that FastAPI is running.',
            )
            hls.startLoad()
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setError('Media playback error. Attempting recovery...')
            hls.recoverMediaError()
          } else {
            setError(data.details || 'Unable to play this HLS stream.')
            hls.destroy()
            hlsRef.current = null
          }
        }
      })

      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl
      setStatus('Native HLS')
    } else {
      setStatus('Unsupported')
      setError('This browser does not support HLS playback.')
    }

    return () => {
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('progress', handleProgress)
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('ended', handleEnded)

      if (hls) {
        hls.destroy()
      }

      hlsRef.current = null

      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [streamUrl])

  function resetMeasurements() {
    setSegmentSamples([])
    setBufferSeconds(0)
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    setLevels([])
    setSelectedQuality('auto')
    setActiveQuality('Detecting')
    setError('')
  }

  function handleNetworkModeChange(event) {
    resetMeasurements()
    setNetworkMode(event.target.value)
  }

  function handleBandwidthChange(event) {
    resetMeasurements()
    setSimulatedBandwidth(event.target.value)
  }

  function handleQualityChange(event) {
    const value = event.target.value

    setSelectedQuality(value)

    const hls = hlsRef.current
    if (!hls) return

    if (value === 'auto') {
      hls.currentLevel = -1
    } else {
      hls.currentLevel = Number(value)
    }
  }

  const progress = duration > 0
    ? (currentTime / duration) * 100
    : 0

  const currentThroughput = segmentSamples[0]?.throughputMbps
  const previousThroughput = segmentSamples[1]?.throughputMbps
  const currentTtfb = segmentSamples[0]?.ttfbMs

  const averageThroughput = segmentSamples.length > 0
    ? segmentSamples.reduce(
        (total, sample) => total + sample.throughputMbps,
        0,
      ) / segmentSamples.length
    : null

  // Compare the latest five downloads with the preceding five.
  const throughputTrend = (() => {
    if (segmentSamples.length < MAX_SEGMENT_SAMPLES) {
      return null
    }

    const recentSamples = segmentSamples.slice(0, 5)
    const previousSamples = segmentSamples.slice(5, 10)

    const recentAverage = recentSamples.reduce(
      (total, sample) => total + sample.throughputMbps,
      0,
    ) / recentSamples.length

    const previousAverage = previousSamples.reduce(
      (total, sample) => total + sample.throughputMbps,
      0,
    ) / previousSamples.length

    if (previousAverage <= 0) return null

    const changePercentage =
      ((recentAverage - previousAverage) / previousAverage) * 100

    if (changePercentage > 5) {
      return `Increasing · ${changePercentage.toFixed(1)}%`
    }

    if (changePercentage < -5) {
      return `Decreasing · ${Math.abs(changePercentage).toFixed(1)}%`
    }

    return `Stable · ${changePercentage.toFixed(1)}%`
  })()

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">P</div>
          <div>
            <h1>Stream<span>Sense</span></h1>
            <p>Predictive Adaptive Video Streaming</p>
          </div>
        </div>

        <div className="connection-status">
          <span className={`status-dot ${status === 'Error' ? 'offline' : ''}`} />
          <span>{status}</span>
        </div>
      </header>

      <section className="welcome-section">
        <div>
          <p className="eyebrow">STREAMING WORKSPACE</p>
          <h2>Adaptive Streaming Dashboard</h2>
          <p className="welcome-description">
            Experience real HLS video streaming across multiple quality levels.
          </p>
        </div>

        <div className="live-indicator">
          <span />
          VIDEO ON DEMAND
        </div>
      </section>

      <section className="main-grid">
        <div className="player-panel">
          <div className="panel-heading">
            <div>
              <h3>Video Player</h3>
              <p>Source: Generated HLS stream</p>
            </div>
            <span className="stream-tag">HLS</span>
          </div>

          <div className="video-container">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              className="video-element"
            />

            {error && (
              <div className="error-message">
                <strong>Playback issue</strong>
                <p>{error}</p>
              </div>
            )}
          </div>

          <div className="player-information">
            <div className="progress-information">
              <span>{formatTime(currentTime)}</span>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span>{formatTime(duration)}</span>
            </div>

            <div className="player-bottom">
              <div className="playback-status">
                <span className={`status-dot ${playing ? '' : 'idle'}`} />
                {status}
              </div>

              <div className="quality-control">
                <label htmlFor="quality">QUALITY</label>
                <select
                  id="quality"
                  value={selectedQuality}
                  onChange={handleQualityChange}
                  disabled={levels.length === 0}
                >
                  <option value="auto">Auto</option>
                  {levels.map((level) => (
                    <option key={level.index} value={String(level.index)}>
                      {level.height}p
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        <aside className="information-panel">
          <div className="panel-heading">
            <div>
              <h3>Stream Information</h3>
              <p>Live player information</p>
            </div>
            <span className="info-icon">i</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">CURRENT QUALITY</span>
            <strong>{activeQuality}</strong>
            <span className="metric-caption">
              Quality currently reported by the player
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">PLAYBACK MODE</span>
            <strong>{selectedQuality === 'auto' ? 'Automatic' : 'Manual'}</strong>
            <span className="metric-caption">
              {selectedQuality === 'auto'
                ? 'HLS.js adaptive quality selection'
                : 'User-selected quality level'}
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">AVAILABLE QUALITIES</span>
            <strong>{levels.length}</strong>
            <span className="metric-caption">
              Quality levels loaded from the master playlist
            </span>
          </div>

          <div className="quality-list">
            <h4>Available Resolutions</h4>
            {levels.length === 0 ? (
              <p className="empty-state">Waiting for playlist...</p>
            ) : (
              levels.map((level) => (
                <div className="quality-item" key={level.index}>
                  <span>{level.height}p</span>
                  <span>{(level.bitrate / 1000000).toFixed(2)} Mbps</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </section>

      {/* Network Simulation */}
      <section className="information-panel simulation-panel">
        <div className="panel-heading">
          <div>
            <h3>Network Simulation</h3>
            <p>Test streaming under controlled bandwidth conditions</p>
          </div>
          <span className="stream-tag">EXPERIMENT</span>
        </div>

        <div className="simulation-controls">
          <div className="simulation-control">
            <label htmlFor="network-mode">NETWORK MODE</label>
            <select
              id="network-mode"
              value={networkMode}
              onChange={handleNetworkModeChange}
            >
              <option value="normal">Normal Network</option>
              <option value="simulated">Simulated Network</option>
            </select>
          </div>

          <div className="simulation-control">
            <label htmlFor="bandwidth">SIMULATED BANDWIDTH</label>
            <select
              id="bandwidth"
              value={simulatedBandwidth}
              onChange={handleBandwidthChange}
              disabled={networkMode !== 'simulated'}
            >
              <option value="0.5">0.5 Mbps</option>
              <option value="1">1 Mbps</option>
              <option value="2">2 Mbps</option>
              <option value="5">5 Mbps</option>
              <option value="10">10 Mbps</option>
            </select>
          </div>
        </div>

        <div className="simulation-status">
          <span className={`status-dot ${networkMode === 'simulated' ? '' : 'idle'}`} />
          {networkMode === 'simulated'
            ? `Simulation active - ${simulatedBandwidth} Mbps configured`
            : 'Normal streaming - No artificial bandwidth limit'}
        </div>
      </section>

      <section className="main-grid">
        <div className="information-panel">
          <div className="panel-heading">
            <div>
              <h3>Network Monitoring</h3>
              <p>Measurements from completed HLS video downloads</p>
            </div>
            <span className="stream-tag">LIVE DATA</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">LATEST SEGMENT THROUGHPUT</span>
            <strong>{formatMbps(currentThroughput)}</strong>
            <span className="metric-caption">
              Effective throughput of the most recently downloaded video segment
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">PREVIOUS SEGMENT THROUGHPUT</span>
            <strong>{formatMbps(previousThroughput)}</strong>
            <span className="metric-caption">
              Throughput measured for the preceding video segment
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">AVERAGE THROUGHPUT</span>
            <strong>{formatMbps(averageThroughput)}</strong>
            <span className="metric-caption">
              Average of the latest {segmentSamples.length} recorded segment downloads
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">REQUEST TO FIRST BYTE (TTFB)</span>
            <strong>{formatTtfb(currentTtfb)}</strong>
            <span className="metric-caption">
              Time from segment request start to first response data
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">THROUGHPUT TREND</span>
            <strong>{throughputTrend || 'Collecting data'}</strong>
            <span className="metric-caption">
              Compares the latest five downloads with the preceding five
            </span>
          </div>

          <div className="metric-card">
            <span className="metric-label">PLAYBACK BUFFER</span>
            <strong>
              {segmentSamples.length > 0 || playing
                ? `${bufferSeconds.toFixed(2)} sec`
                : '—'}
            </strong>
            <span className="metric-caption">
              Buffered video ahead of the current playback position
            </span>
          </div>
        </div>

        <div className="information-panel">
          <div className="panel-heading">
            <div>
              <h3>Recent Segment Downloads</h3>
              <p>Latest completed video fragment measurements</p>
            </div>
          </div>

          {segmentSamples.length === 0 ? (
            <p className="empty-state">
              No segment measurements yet. Start video playback to collect data.
            </p>
          ) : (
            <div className="quality-list">
              {segmentSamples.map((sample, index) => (
                <div className="quality-item" key={sample.id}>
                  <span>
                    {index === 0 ? 'Latest' : sample.quality}
                    {index === 0 ? ` · ${sample.quality}` : ''}
                  </span>
                  <span>
                    {formatMbps(sample.throughputMbps)}
                    {' · '}
                    {formatBytes(sample.bytes)}
                    {' · '}
                    {sample.durationSeconds.toFixed(2)} sec
                    {' · TTFB '}
                    {formatTtfb(sample.ttfbMs)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="metric-caption">
            Measurements are collected from HLS.js completed main-fragment
            download statistics. Native HLS playback does not expose these
            HLS.js fragment events.
          </p>
        </div>
      </section>

      <section className="bottom-note">
        <div className="note-icon">✓</div>
        <div>
          <strong>Real HLS stream connected</strong>
          <p>
            Segment throughput, request-to-first-byte time and playback buffer
            are measured from actual playback activity. Network simulation
            controls the bandwidth of actual HLS segment downloads. Predictive
            AI quality selection will be integrated in later phases.
          </p>
        </div>
      </section>

      <footer className="footer">
        <span>StreamSense · Predictive Adaptive Streaming System</span>
        <span>Development Environment</span>
      </footer>
    </main>
  )
}

export default App
