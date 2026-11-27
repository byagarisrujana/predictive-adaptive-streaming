
import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import './App.css'

const API_BASE_URL = 'http://127.0.0.1:8000'
const STREAM_URL = `${API_BASE_URL}/hls/master.m3u8`
const SIMULATOR_URL = `${API_BASE_URL}/simulated-hls`
const MAX_SEGMENT_SAMPLES = 10
const AI_SAFETY_MARGIN = 0.75
const AI_UPGRADE_BUFFER_SECONDS = 8

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

function getCurrentBufferSeconds(video) {
  if (!video || video.buffered.length === 0) return 0

  const playbackPosition = video.currentTime

  for (let index = 0; index < video.buffered.length; index += 1) {
    const rangeStart = video.buffered.start(index)
    const rangeEnd = video.buffered.end(index)

    if (
      playbackPosition >= rangeStart &&
      playbackPosition <= rangeEnd
    ) {
      return Math.max(0, rangeEnd - playbackPosition)
    }
  }

  return 0
}

function App() {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const activeExperimentRef = useRef(null)
  const measurementQueueRef = useRef(Promise.resolve())
  const stoppingExperimentRef = useRef(false)

  const selectedQualityRef = useRef('auto')
  const predictionRequestRef = useRef(false)
  const predictionGenerationRef = useRef(0)

  // Playback evaluation tracking.
  const playbackStartedRef = useRef(false)
  const rebufferingRef = useRef(null)
  const lastQualityLevelRef = useRef(null)

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

  // AI prediction state.
  const [predictedThroughput, setPredictedThroughput] = useState(null)
  const [predictionStatus, setPredictionStatus] = useState('Waiting for data')
  const [predictionError, setPredictionError] = useState('')

  // Network simulation settings.
  const [networkMode, setNetworkMode] = useState('normal')
  const [simulatedBandwidth, setSimulatedBandwidth] = useState('1')

  // Experiment recording state.
  const [activeExperimentId, setActiveExperimentId] = useState(null)
  const [experimentBusy, setExperimentBusy] = useState(false)
  const [experimentMessage, setExperimentMessage] = useState('')
  const [experimentError, setExperimentError] = useState('')

  const experimentActive = activeExperimentId !== null

  const streamUrl = networkMode === 'simulated'
    ? `${SIMULATOR_URL}/${simulatedBandwidth}/master.m3u8`
    : networkMode === 'dynamic' && activeExperimentId !== null
      ? `${SIMULATOR_URL}/dynamic/experiment_${activeExperimentId}/master.m3u8`
      : STREAM_URL

  // Queue experiment API requests so that stopping an experiment
  // waits for all pending measurements and metric updates.
  const queueExperimentRequest = useCallback((
    experimentId,
    endpoint,
    payload = null,
  ) => {
    measurementQueueRef.current = measurementQueueRef.current
      .then(async () => {
        const options = {
          method: 'POST',
        }

        if (payload !== null) {
          options.headers = {
            'Content-Type': 'application/json',
          }
          options.body = JSON.stringify(payload)
        }

        const response = await fetch(
          `${API_BASE_URL}/experiments/${experimentId}/${endpoint}`,
          options,
        )

        const result = await response.json().catch(() => null)

        if (!response.ok) {
          throw new Error(
            result?.detail || `Experiment request failed: HTTP ${response.status}`,
          )
        }
      })
      .catch((uploadError) => {
        console.error(uploadError)
        setExperimentError(
          'An experiment metric could not be saved. Check the backend connection.',
        )
      })
  }, [])

  // Finish an active buffering interruption and queue its duration.
  const finishRebuffering = useCallback(() => {
    const rebuffering = rebufferingRef.current

    if (!rebuffering) return

    rebufferingRef.current = null

    const durationSeconds =
      (Date.now() - rebuffering.startedAt) / 1000

    if (
      durationSeconds > 0 &&
      rebuffering.experimentId !== null
    ) {
      queueExperimentRequest(
        rebuffering.experimentId,
        'rebuffering',
        {
          duration_seconds: durationSeconds,
        },
      )
    }
  }, [queueExperimentRequest])

  // Select a quality level using predicted throughput and buffer conditions.
  const applyAiQuality = useCallback((prediction, currentBuffer) => {
    const hls = hlsRef.current

    if (
      !hls ||
      selectedQualityRef.current !== 'ai' ||
      !Number.isFinite(prediction) ||
      prediction <= 0 ||
      hls.levels.length === 0
    ) {
      return
    }

    const safetyMargin = currentBuffer < 3
      ? 0.50
      : currentBuffer < 8
        ? 0.60
        : AI_SAFETY_MARGIN

    const safeBandwidth = prediction * safetyMargin

    let targetLevel = 0

    hls.levels.forEach((level, index) => {
      const bitrateMbps = level.bitrate / 1000000

      if (bitrateMbps <= safeBandwidth) {
        targetLevel = index
      }
    })

    const currentLevel = hls.currentLevel >= 0
      ? hls.currentLevel
      : hls.loadLevel

    if (
      currentLevel >= 0 &&
      targetLevel > currentLevel &&
      currentBuffer < AI_UPGRADE_BUFFER_SECONDS
    ) {
      return
    }

    if (currentLevel !== targetLevel) {
      hls.currentLevel = targetLevel
    }
  }, [])

  // Request a five-second-ahead throughput prediction from FastAPI.
  const requestThroughputPrediction = useCallback(async (
    sample,
    currentBuffer,
    qualityHeight,
  ) => {
    if (predictionRequestRef.current) return

    if (
      !Number.isFinite(sample.throughputMbps) ||
      sample.throughputMbps <= 0 ||
      !Number.isFinite(sample.durationSeconds) ||
      sample.durationSeconds <= 0 ||
      !Number.isFinite(sample.ttfbMs) ||
      sample.ttfbMs < 0 ||
      !Number.isFinite(currentBuffer) ||
      currentBuffer < 0 ||
      !Number.isFinite(qualityHeight) ||
      qualityHeight <= 0
    ) {
      return
    }

    predictionRequestRef.current = true
    const requestGeneration = predictionGenerationRef.current

    setPredictionStatus('Predicting...')
    setPredictionError('')

    try {
      const response = await fetch(`${API_BASE_URL}/predictions/throughput`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          throughput_mbps_current: sample.throughputMbps,
          download_duration_seconds_current: sample.durationSeconds,
          ttfb_ms_current: sample.ttfbMs,
          buffer_seconds_current: currentBuffer,
          quality_height_current: qualityHeight,
        }),
      })

      if (!response.ok) {
        throw new Error(`Prediction API returned HTTP ${response.status}`)
      }

      const result = await response.json()

      if (
        !Number.isFinite(result.predicted_throughput_mbps) ||
        result.predicted_throughput_mbps <= 0
      ) {
        throw new Error('The prediction API returned an invalid value.')
      }

      if (requestGeneration !== predictionGenerationRef.current) {
        return
      }

      setPredictedThroughput(result.predicted_throughput_mbps)
      setPredictionStatus('Prediction ready')

      if (selectedQualityRef.current === 'ai') {
        applyAiQuality(result.predicted_throughput_mbps, currentBuffer)
      }
    } catch (predictionRequestError) {
      if (requestGeneration === predictionGenerationRef.current) {
        setPredictionStatus('Prediction unavailable')
        setPredictionError(predictionRequestError.message)
      }
    } finally {
      if (requestGeneration === predictionGenerationRef.current) {
        predictionRequestRef.current = false
      }
    }
  }, [applyAiQuality])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls = null

    setStatus('Connecting')
    setError('')

    function updateBuffer() {
      setBufferSeconds(getCurrentBufferSeconds(video))
    }

    const handlePlaying = () => {
      // A playing event ends any previously recorded buffering interruption.
      finishRebuffering()

      playbackStartedRef.current = true
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

      // Ignore initial startup buffering. Count interruptions only
      // after playback has successfully started.
      if (
        playbackStartedRef.current &&
        !rebufferingRef.current
      ) {
        const activeExperiment = activeExperimentRef.current

        rebufferingRef.current = {
          startedAt: Date.now(),
          experimentId:
            activeExperiment && !stoppingExperimentRef.current
              ? activeExperiment.id
              : null,
        }
      }
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
      finishRebuffering()
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
        lastQualityLevelRef.current = null
      })

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const level = hls.levels[data.level]

        if (level) {
          setActiveQuality(`${level.height}p`)

          // The first selected level is not counted as a switch.
          const previousLevel = lastQualityLevelRef.current

          if (
            previousLevel !== null &&
            previousLevel !== data.level
          ) {
            const activeExperiment = activeExperimentRef.current

            if (
              activeExperiment &&
              !stoppingExperimentRef.current
            ) {
              queueExperimentRequest(
                activeExperiment.id,
                'quality-switch',
              )
            }
          }

          lastQualityLevelRef.current = data.level
        }
      })

      // Collect measurements from completed video fragments.
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        const fragment = data.frag

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
        const videoElement = videoRef.current
        const observedAt = new Date().toISOString()
        const currentBuffer = getCurrentBufferSeconds(videoElement)

        const sample = {
          id: `${fragment.level}-${fragment.sn}-${Date.now()}`,
          quality: level ? `${level.height}p` : 'Unknown',
          bytes: downloadedBytes,
          durationSeconds: downloadDurationMs / 1000,
          throughputMbps,
          ttfbMs,
        }

        void requestThroughputPrediction(
          sample,
          currentBuffer,
          level?.height,
        )

        setSegmentSamples((previousSamples) =>
          [sample, ...previousSamples].slice(0, MAX_SEGMENT_SAMPLES),
        )

        const activeExperiment = activeExperimentRef.current

        if (activeExperiment && !stoppingExperimentRef.current) {
          const measurement = {
            observed_at: observedAt,
            segment_number: String(fragment.sn),
            quality_height: level?.height ?? null,
            bytes_downloaded: downloadedBytes,
            download_duration_seconds: downloadDurationMs / 1000,
            throughput_mbps: throughputMbps,
            ttfb_ms: ttfbMs,
            buffer_seconds: currentBuffer,
            playback_position_seconds: videoElement?.currentTime ?? 0,
          }

          queueExperimentRequest(
            activeExperiment.id,
            'measurements',
            measurement,
          )
        }
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
  }, [
    streamUrl,
    requestThroughputPrediction,
    finishRebuffering,
    queueExperimentRequest,
  ])

  function resetMeasurements() {
    predictionGenerationRef.current += 1
    predictionRequestRef.current = false

    playbackStartedRef.current = false
    rebufferingRef.current = null
    lastQualityLevelRef.current = null

    setSegmentSamples([])
    setBufferSeconds(0)
    setPredictedThroughput(null)
    setPredictionStatus('Waiting for data')
    setPredictionError('')
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    setLevels([])
    setSelectedQuality('auto')
    selectedQualityRef.current = 'auto'
    setActiveQuality('Detecting')
    setError('')
  }

  function handleNetworkModeChange(event) {
    if (experimentActive || experimentBusy) return

    resetMeasurements()
    setNetworkMode(event.target.value)
  }

  function handleBandwidthChange(event) {
    if (experimentActive || experimentBusy) return

    resetMeasurements()
    setSimulatedBandwidth(event.target.value)
  }

  async function handleStartExperiment() {
    if (activeExperimentRef.current || experimentBusy) return

    setExperimentBusy(true)
    setExperimentError('')
    setExperimentMessage('Starting experiment...')

    const algorithm = selectedQualityRef.current === 'ai'
      ? 'ai'
      : selectedQualityRef.current === 'auto'
        ? 'hls_auto'
        : 'manual'

    const experimentDetails = {
      network_mode: networkMode,
      algorithm,
      configured_bandwidth_mbps:
        networkMode === 'simulated'
          ? Number(simulatedBandwidth)
          : null,
    }

    try {
      const response = await fetch(`${API_BASE_URL}/experiments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(experimentDetails),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.detail || 'Could not start the experiment.',
        )
      }

      if (networkMode === 'dynamic') {
        const scenarioId = `experiment_${result.experiment_id}`

        const scheduleResponse = await fetch(
          `${API_BASE_URL}/simulated-hls/dynamic/${scenarioId}/schedule`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              schedule: [
                { end_time_seconds: 8, bandwidth_mbps: 2.0 },
                { end_time_seconds: 18, bandwidth_mbps: 0.5 },
                { end_time_seconds: 24, bandwidth_mbps: 5.0 },
                { end_time_seconds: 40, bandwidth_mbps: 1.0 },
              ],
            }),
          },
        )

        const scheduleResult = await scheduleResponse.json()

        if (!scheduleResponse.ok) {
          throw new Error(
            scheduleResult.detail || 'Could not configure the dynamic schedule.',
          )
        }
      }

      activeExperimentRef.current = {
        id: result.experiment_id,
      }

      measurementQueueRef.current = Promise.resolve()
      stoppingExperimentRef.current = false
      rebufferingRef.current = null
      lastQualityLevelRef.current = null

      setActiveExperimentId(result.experiment_id)
      setExperimentMessage(
        `Recording experiment #${result.experiment_id} (${algorithm}). Play the video to collect measurements.`,
      )
    } catch (startError) {
      console.error(startError)
      setExperimentError(startError.message)
      setExperimentMessage('')
    } finally {
      setExperimentBusy(false)
    }
  }

  async function handleStopExperiment() {
    const activeExperiment = activeExperimentRef.current

    if (!activeExperiment || experimentBusy) return

    setExperimentBusy(true)
    setExperimentError('')
    setExperimentMessage('Finishing pending measurement uploads...')

    // Close and record a buffering interruption if one is still active.
    finishRebuffering()

    stoppingExperimentRef.current = true

    try {
      await measurementQueueRef.current

      setExperimentMessage('Stopping experiment...')

      const response = await fetch(
        `${API_BASE_URL}/experiments/${activeExperiment.id}/stop`,
        {
          method: 'POST',
        },
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.detail || 'Could not stop the experiment.',
        )
      }

      activeExperimentRef.current = null
      stoppingExperimentRef.current = false
      rebufferingRef.current = null
      lastQualityLevelRef.current = null

      setActiveExperimentId(null)
      setExperimentMessage(
        `Experiment #${activeExperiment.id} stopped successfully.`,
      )
    } catch (stopError) {
      console.error(stopError)

      stoppingExperimentRef.current = false
      setExperimentError(stopError.message)
      setExperimentMessage(
        `Experiment #${activeExperiment.id} is still active.`,
      )
    } finally {
      setExperimentBusy(false)
    }
  }

  function handleQualityChange(event) {
    if (experimentActive || experimentBusy) return

    const value = event.target.value

    setSelectedQuality(value)
    selectedQualityRef.current = value

    const hls = hlsRef.current
    if (!hls) return

    if (value === 'auto') {
      hls.currentLevel = -1
    } else if (value === 'ai') {
      hls.currentLevel = -1

      if (predictedThroughput !== null) {
        applyAiQuality(predictedThroughput, bufferSeconds)
      }
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
                  disabled={
                    levels.length === 0 ||
                    experimentActive ||
                    experimentBusy
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="ai">AI Smart Auto</option>
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
            <strong>
              {selectedQuality === 'ai'
                ? 'AI Smart Auto'
                : selectedQuality === 'auto'
                  ? 'Automatic'
                  : 'Manual'}
            </strong>
            <span className="metric-caption">
              {selectedQuality === 'ai'
                ? 'Quality selected using predicted throughput and buffer'
                : selectedQuality === 'auto'
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
              disabled={experimentActive || experimentBusy}
            >
              <option value="normal">Normal Network</option>
              <option value="simulated">Simulated Network</option>
              <option value="dynamic">Dynamic Network (Scheduled)</option>
            </select>
          </div>

          <div className="simulation-control">
            <label htmlFor="bandwidth">SIMULATED BANDWIDTH</label>
            <select
              id="bandwidth"
              value={simulatedBandwidth}
              onChange={handleBandwidthChange}
              disabled={
                networkMode !== 'simulated' ||
                experimentActive ||
                experimentBusy
              }
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
          <span className={`status-dot ${
            networkMode === 'simulated' || networkMode === 'dynamic'
              ? ''
              : 'idle'
          }`} />
          {networkMode === 'dynamic'
            ? 'Dynamic simulation active - 2 → 0.5 → 5 → 1 Mbps schedule'
            : networkMode === 'simulated'
              ? `Simulation active - ${simulatedBandwidth} Mbps configured`
              : 'Normal streaming - No artificial bandwidth limit'}
        </div>

        <div className="experiment-controls">
          <button
            type="button"
            className="experiment-button start-experiment-button"
            onClick={handleStartExperiment}
            disabled={experimentActive || experimentBusy}
          >
            Start Experiment
          </button>

          <button
            type="button"
            className="experiment-button stop-experiment-button"
            onClick={handleStopExperiment}
            disabled={!experimentActive || experimentBusy}
          >
            Stop Experiment
          </button>
        </div>

        <div className="experiment-information">
          <p>
            <strong>Experiment ID:</strong>{' '}
            {activeExperimentId ?? 'No active experiment'}
          </p>

          {experimentMessage && (
            <p className="experiment-message">{experimentMessage}</p>
          )}

          {experimentError && (
            <p className="experiment-error">{experimentError}</p>
          )}
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

          <div className="metric-card">
            <span className="metric-label">AI PREDICTED THROUGHPUT</span>
            <strong>{formatMbps(predictedThroughput)}</strong>
            <span className="metric-caption">
              Estimated network throughput approximately 5 seconds ahead
            </span>
            <span className="metric-caption">
              {predictionStatus}
            </span>
            {predictionError && (
              <span className="experiment-error">{predictionError}</span>
            )}
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
          <strong>AI prediction and quality selection integrated</strong>
          <p>
            The trained Linear Regression model predicts throughput using
            actual segment measurements. AI Smart Auto uses the prediction,
            available stream bitrates, and playback buffer to select a
            resolution with a conservative bandwidth margin. HLS.js Auto
            and manual quality selection remain available for comparison.
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
