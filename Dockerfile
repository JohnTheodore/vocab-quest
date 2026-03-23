FROM node:20-alpine

WORKDIR /app

# Copy package files and install all dependencies (including devDependencies for Vite)
COPY package*.json ./
RUN npm install

# Copy the rest of the source
COPY . .

# Expose Express API server and Vite dev server
EXPOSE 3001
EXPOSE 5173

# Run both servers concurrently, same as local dev
CMD ["npm", "run", "dev"]
