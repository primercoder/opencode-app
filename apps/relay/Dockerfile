FROM golang:1.27-alpine AS build
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=sum.golang.google.cn
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ocremote-relay ./cmd/relay

FROM scratch
COPY --from=build /out/ocremote-relay /ocremote-relay
EXPOSE 8080
ENTRYPOINT ["/ocremote-relay"]
