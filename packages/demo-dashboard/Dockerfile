FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx next build

FROM nginx:alpine
COPY --from=builder /app/out /usr/share/nginx/html
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    location /demo/ {\n\
        alias /usr/share/nginx/html/;\n\
        try_files $uri $uri.html $uri/ /demo/index.html;\n\
    }\n\
\n\
    location / {\n\
        return 301 /demo/;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
