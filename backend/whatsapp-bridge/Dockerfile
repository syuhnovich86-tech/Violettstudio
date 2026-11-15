FROM golang:1.27-alpine AS build
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=1 go test ./...
RUN CGO_ENABLED=1 go build -trimpath -o /whatsapp-bridge .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && addgroup -g 10001 -S vita29 && adduser -u 10001 -S -G vita29 vita29
COPY --from=build /whatsapp-bridge /usr/local/bin/whatsapp-bridge
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/whatsapp-bridge"]
