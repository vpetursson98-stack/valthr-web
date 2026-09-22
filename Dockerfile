FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 8080
CMD sed -i 's/listen       80/listen       8080/' /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'
