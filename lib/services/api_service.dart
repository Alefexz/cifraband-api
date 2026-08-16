import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiService {
  static const String _baseUrl = 'https://cifraband-api.onrender.com';

  static Future<List<Map<String, dynamic>>> searchCatalog(String query) async {
    try {
      final url = Uri.parse(
        'https://itunes.apple.com/search?term=${Uri.encodeComponent(query)}&entity=song&limit=15',
      );

      final response = await http
          .get(url)
          .timeout(const Duration(seconds: 5));

      if (response.statusCode != 200) return [];

      final data = json.decode(response.body);
      final results = <Map<String, dynamic>>[];

      for (final item in data['results'] ?? []) {
        results.add({
          'title': item['trackName'] ?? 'Desconhecido',
          'artist': item['artistName'] ?? 'Desconhecido',
          'imageUrl': item['artworkUrl100']
                  ?.replaceAll('100x100bb', '300x300bb') ??
              '',
        });
      }

      return results;
    } catch (_) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> downloadCifra(
    String artist,
    String track,
  ) async {
    final url = Uri.parse(
      '$_baseUrl/searchSong'
      '?artist=${Uri.encodeQueryComponent(artist)}'
      '&track=${Uri.encodeQueryComponent(track)}',
    );

    print('🎸 CifraBand API');
    print('👤 Artista: $artist');
    print('🎵 Música: $track');
    print('🌐 URL: $url');

    try {
      final response = await http
          .get(
            url,
            headers: {
              'Accept': 'application/json',
            },
          )
          .timeout(const Duration(seconds: 15));

      print('📡 Status HTTP: ${response.statusCode}');
      print('📦 Resposta: ${response.body.length} bytes');

      if (response.statusCode == 200) {
        final data = json.decode(response.body);

        if (data is! Map<String, dynamic>) {
          throw Exception('Resposta inválida recebida do servidor.');
        }

        print('✅ Cifra recebida: ${data['title']}');
        print('🎼 Tom real: ${data['originalKey']}');
        print('🎸 Forma: ${data['shapeKey']}');
        print('🦋 Capo: ${data['capo']}');

        return data;
      }

      if (response.statusCode == 404) {
        throw Exception(
          'Cifra não encontrada para "$artist - $track".',
        );
      }

      if (response.statusCode >= 500) {
        throw Exception(
          'O servidor CifraBand está temporariamente indisponível '
          '(${response.statusCode}).',
        );
      }

      throw Exception(
        'Erro na API CifraBand: HTTP ${response.statusCode}.',
      );
    } on http.ClientException catch (e) {
      print('❌ Erro de conexão: $e');
      throw Exception(
        'Não foi possível conectar ao servidor CifraBand.',
      );
    } on FormatException catch (e) {
      print('❌ JSON inválido: $e');
      throw Exception(
        'O servidor respondeu com dados inválidos.',
      );
    } catch (e) {
      print('❌ Erro downloadCifra: $e');
      rethrow;
    }
  }
}