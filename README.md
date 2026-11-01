# Predictive AI-Based Adaptive Video Streaming Optimization System

## Project Overview

A real-time adaptive video streaming application that uses machine learning to predict future network bandwidth and proactively adjust video quality.

The objective is to reduce buffering and improve Quality of Experience (QoE) under dynamic network conditions.

## Key Features

- Multi-resolution HLS video streaming
- Real-time network monitoring
- Bandwidth prediction using XGBoost
- AI-based adaptive video quality selection
- Network condition simulation
- Conventional ABR vs AI-based streaming comparison
- Experiment tracking and performance evaluation

## Technology Stack

### Frontend
- React.js
- Vite
- Tailwind CSS
- HLS.js
- Recharts
- Motion for React

### Backend
- Python
- FastAPI
- WebSockets
- SQLite

### Video Processing
- FFmpeg
- HTTP Live Streaming (HLS)

### Machine Learning
- Pandas
- NumPy
- Scikit-learn
- XGBoost
- Matplotlib

## Development Status

Currently in Phase 0: Environment and Project Setup.

## Project Goal

To investigate whether predictive bandwidth estimation and proactive bitrate adaptation can improve video streaming performance compared with conventional reactive adaptive bitrate streaming.

## Evaluation Metrics

- Total rebuffering duration
- Number of buffering events
- Average delivered video quality
- Quality switching frequency
- Bandwidth prediction MAE and RMSE

## Author

Byagari Srujana

## License

To be decided.
