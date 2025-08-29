FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/poller ./cmd/poller

FROM alpine:3.20
WORKDIR /app
COPY --from=builder /out/poller /app/poller
ENV PORT=8080
CMD ["/app/poller"]