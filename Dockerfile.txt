FROM debian:bookworm-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Arduino CLI
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
ENV PATH="/root/bin:${PATH}"

# Initialize Arduino CLI and install cores
RUN arduino-cli config init && \
    arduino-cli core update-index && \
    arduino-cli core install arduino:avr

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install Node.js dependencies
RUN npm install

# Copy server code
COPY server.js ./

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]
