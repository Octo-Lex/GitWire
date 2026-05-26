FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx next build

FROM nginx:alpine
COPY --from=builder /app/out /usr/share/nginx/html/demo
RUN echo 'server {\
    listen 80;\
    root /usr/share/nginx/html;\
    index index.html;\
    add_header Cache-Control "public, max-age=3600";\
    location /demo {\
        return 301 /demo/;\
    }\
    location /demo/_next/ {\
        alias /usr/share/nginx/html/demo/_next/;\
        add_header Cache-Control "public, max-age=31536000, immutable";\
    }\
    location /demo/ {\
        alias /usr/share/nginx/html/demo/;\
        try_files $uri $uri/index.html =404;\
    }\
    location / {\
        return 301 /demo/;\
    }\
}' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
