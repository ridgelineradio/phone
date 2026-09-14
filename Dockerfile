FROM node:20-slim

# Install system dependencies for ffmpeg and native module builds (better-sqlite3)
RUN apt-get update && apt-get install -y ffmpeg python3 make g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Expose the port used by your app
ENV PORT=3000
EXPOSE $PORT

# Start the app
CMD [ "node", "server.js" ]
