FROM node:22-slim

# Install runtime init and native-module build tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

# Create and set the working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Specify the command to run
CMD ["npm", "run", "start"]
