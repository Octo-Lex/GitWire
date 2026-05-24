# Build VitePress static docs site
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . ./
RUN npm run docs:build

# Serve with nginx
FROM nginx:alpine
COPY --from=build /app/.vitepress/dist /usr/share/nginx/html
RUN echo 'server { \
    listen 80; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ $uri.html /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
