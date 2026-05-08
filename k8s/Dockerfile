FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY app.js load-generator.js ./
EXPOSE 3000
CMD ["node", "app.js"]
