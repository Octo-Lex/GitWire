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
    location /demo {\
        return 301 /demo/;\
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
