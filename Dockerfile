# LumaFetch Development Dockerfile
FROM node:20-slim

# Install Python and dependencies for yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy application files
COPY . .

# Install Python dependencies
RUN pip3 install --break-system-packages -r requirements.txt

# Expose port for development (if needed)
EXPOSE 3000

# Default command
CMD ["npm", "start"]
