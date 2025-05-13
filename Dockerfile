FROM node:20-slim

# Install system dependencies for ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && \
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
