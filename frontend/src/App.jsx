
import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import './App.css'

const STREAM_URL = 'http://127.0.0.1:8000/hls/master.m3u8'

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00'

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
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

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls = null

    const handlePlaying = () => {
      setPlaying(true)
      setStatus('Playing')
    }

    const handlePause = () => {
      setPlaying(false)
      if (!video.ended) setStatus('Paused')
    }

    const handleWaiting = () => {
      setStatus('Buffering')
    }

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime)
    }

    const handleLoadedMetadata = () => {
      setDuration(video.duration)
    }

    const handleEnded = () => {
      setPlaying(false)
      setStatus('Finished')
    }

    video.addEventListener('playing', handlePlaying)
    video.addEventListener('pause', handlePause)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('ended', handleEnded)

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
      })

      hlsRef.current = hls

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(STREAM_URL)
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

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setStatus('Error')

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setError('Network error while loading the video. Check that FastAPI is running.')
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
      video.src = STREAM_URL
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
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('ended', handleEnded)

      if (hls) {
        hls.destroy()
      }

      hlsRef.current = null
    }
  }, [])

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

      <section className="bottom-note">
        <div className="note-icon">✓</div>
        <div>
          <strong>Real HLS stream connected</strong>
          <p>
            Video playlists and segments are served by your FastAPI backend.
            AI prediction and network monitoring will be integrated in later phases.
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
